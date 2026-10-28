/**
 * 秘密执行中介（P2，docs/CREDENTIALS-VAULT.md §7）。
 *
 * 干什么
 * ------
 * `confirm` / `local-only` 级凭据**不注入到 pi 的进程环境**（P1b 的决定），所以
 * agent 想用它们只能通过 `mpi_secret_run` 工具：扩展把 {凭据名, 命令} 丢进收件箱，
 * 主进程在这里判策略、解密、带着 `MPI_SECRET_VALUE` 执行一条命令，再把输出写回回执箱。
 *
 * 为什么这么设计
 * --------------
 * - 值只在主进程内存里出现一次，只进被执行的子进程环境：不进 pi 环境、不进对话、
 *   不进快照；
 * - 每次调用都过一次策略，因此「远程需确认 / 仅本机」才有可能真正落地——
 *   环境变量方案（P1b）做不到按次判断；
 * - 命令本身仍由 agent 给出，所以**权限 gate 依然生效**：工具在 pi 侧先用
 *   `ctx.ui.select` 走一次审批卡片（桌面与手机都会显示，复用现有 ui.request 通道），
 *   拒绝就不会走到这里。
 *
 * 目录：<userData>/secret-inbox/ 与 <userData>/secret-outbox/（与 attach-file 同一套模式）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { PromptSource } from "./prompt-source";

export interface SecretBrokerDirs {
  inboxDir: string;
  outboxDir: string;
}

/** 收件箱请求（扩展写）。 */
export interface SecretRunRequest {
  id: string;
  /** 凭据引用名（`{{secret:name}}` 里的 name）。 */
  name: string;
  /** 要执行的命令；值会作为 `MPI_SECRET_VALUE` 注入该子进程环境。 */
  command: string;
  /** 工作目录（默认线程 cwd）。 */
  cwd?: string;
  /** 超时（毫秒），默认 60s，上限 10 分钟。 */
  timeoutMs?: number;
  /** 发起请求的会话（审计与来源解析用）。 */
  threadId?: string;
}

/** 回执（主进程写）。ok=false 时 error 是稳定错误码。 */
export interface SecretRunReceipt {
  id: string;
  ok: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  /** NO_CREDENTIAL / DENIED_LOCAL_ONLY / DENIED_REMOTE / EMPTY_COMMAND / BAD_REQUEST / TIMEOUT / SPAWN_FAILED */
  error?: string;
  /** 输出里出现过凭据值 → 已替换成 ***（告诉模型别去复读） */
  redacted?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** 回执保留 30 分钟；扩展正常几秒就取走。 */
const RECEIPT_TTL_MS = 30 * 60 * 1000;
const MAX_OUTPUT_CHARS = 64 * 1024;

export function ensureSecretBrokerDirs(userDataDir: string): SecretBrokerDirs {
  const inboxDir = join(userDataDir, "secret-inbox");
  const outboxDir = join(userDataDir, "secret-outbox");
  for (const dir of [inboxDir, outboxDir]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* already there */
    }
  }
  return { inboxDir, outboxDir };
}

/** 执行器（注入以便单测；真实实现走 spawn + 系统 shell）。 */
export type SecretRunner = (args: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export interface SecretIngestOptions extends SecretBrokerDirs {
  /** 线程 cwd 兜底（请求没给 cwd 且没有 resolveContext 时用它）。 */
  cwd?: string;
  /** 本轮 prompt 来源兜底：remote 会让 local-only 直接拒绝。 */
  source?: PromptSource | undefined;
  /** 按请求解析上下文（多线程共用一个收件箱时用）：返回该请求所属会话的 cwd 与来源。 */
  resolveContext?: (req: SecretRunRequest) => { cwd: string; source: PromptSource | undefined }; 
  /** 取凭据（含级别与解密后的值）；没有则返回 null。 */
  lookup: (name: string) => { name: string; level: "silent" | "confirm" | "local-only"; value: string } | null;
  /** 审计：只记凭据名与命令摘要，不含值。 */
  audit: (entry: {
    action: "exec" | "deny";
    name?: string;
    reason?: string;
    commandDigest?: string;
    threadId?: string;
  }) => void;
  runner?: SecretRunner;
  now?: () => number;
}

function writeReceipt(outboxDir: string, receipt: SecretRunReceipt): void {
  const target = join(outboxDir, `${receipt.id}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(receipt));
    renameSync(tmp, target); // 扩展轮询时永远读到完整文件
  } catch {
    /* 磁盘满/文件被清 —— agent 那边会超时，这是诚实的失败 */
  }
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : text;
}

/** 把输出里出现的凭据值替换掉（防御纵深：即使命令自己 echo 了也不进对话）。 */
export function redactValue(text: string, value: string): { text: string; redacted: boolean } {
  if (!value || value.length < 4) return { text, redacted: false };
  if (!text.includes(value)) return { text, redacted: false };
  return { text: text.split(value).join("***"), redacted: true };
}

/** 默认执行器：用系统 shell 跑一条命令，值只进子进程环境。 */
export function defaultSecretRunner(): SecretRunner {
  return async ({ command, cwd, env, timeoutMs }) => {
    const isWin = process.platform === "win32";
    // Windows 上走 cmd 语义（与用户日常一致）；其它平台走 /bin/sh。
    const file = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
    return await new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, timeoutMs);
      child.stdout?.on("data", (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += d.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr });
      });
    });
  };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * 处理收件箱里的所有请求（幂等：处理过就删请求；同一个 id 的重投会被回执去重）。
 * 返回处理的请求数，便于 watch/poll 两路共用。
 */
export async function ingestSecretRequests(options: SecretIngestOptions): Promise<number> {
  const runner = options.runner ?? defaultSecretRunner();
  const now = options.now ?? Date.now;
  let handled = 0;
  let files: string[] = [];
  try {
    files = readdirSync(options.inboxDir).filter((f) => f.endsWith(".json"));
  } catch {
    return 0;
  }
  for (const file of files) {
    const full = join(options.inboxDir, file);
    const req = readJson<SecretRunRequest>(full);
    if (!req || typeof req.id !== "string" || !req.id) {
      // 半截文件/坏文件：删掉，别卡住队列
      try {
        rmSync(full, { force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    const receiptFile = join(options.outboxDir, `${req.id}.json`);
    if (existsSync(receiptFile)) {
      // 已经回过执（watch 与 poll 撞车），直接清请求
      try {
        rmSync(full, { force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    // 先删请求再执行：即使执行很慢，watch 也不会重复处理（回执由下面写）
    try {
      rmSync(full, { force: true });
    } catch {
      /* keep going — idempotency still holds via receiptFile */
    }

    const receipt = await handleOne(req, options, runner, now);
    writeReceipt(options.outboxDir, receipt);
    handled++;
  }
  return handled;
}

async function handleOne(
  req: SecretRunRequest,
  options: SecretIngestOptions,
  runner: SecretRunner,
  now: () => number,
): Promise<SecretRunReceipt> {
  const command = typeof req.command === "string" ? req.command.trim() : "";
  if (!command) return { id: req.id, ok: false, error: "EMPTY_COMMAND" };
  const cred = options.lookup(String(req.name || ""));
  if (!cred) {
    options.audit({ action: "deny", name: req.name, reason: "NO_CREDENTIAL", threadId: req.threadId });
    return { id: req.id, ok: false, error: "NO_CREDENTIAL" };
  }
  const ctx = options.resolveContext
    ? options.resolveContext(req)
    : { cwd: options.cwd ?? process.cwd(), source: options.source };
  const remote = ctx.source && ctx.source.kind !== "desktop";
  if (cred.level === "local-only" && remote) {
    options.audit({ action: "deny", name: cred.name, reason: "DENIED_LOCAL_ONLY", threadId: req.threadId });
    return { id: req.id, ok: false, error: "DENIED_LOCAL_ONLY" };
  }
  const timeoutMs = Math.min(
    Math.max(Number(req.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000),
    MAX_TIMEOUT_MS,
  );
  const cwd = typeof req.cwd === "string" && req.cwd ? req.cwd : ctx.cwd;
  const digest = commandDigest(command);
  try {
    const result = await runner({
      command,
      cwd,
      env: { MPI_SECRET_VALUE: cred.value },
      timeoutMs,
    });
    const out = redactValue(clip(result.stdout ?? ""), cred.value);
    const err = redactValue(clip(result.stderr ?? ""), cred.value);
    options.audit({ action: "exec", name: cred.name, commandDigest: digest, threadId: req.threadId });
    return {
      id: req.id,
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: out.text,
      stderr: err.text,
      ...(out.redacted || err.redacted ? { redacted: true } : {}),
    };
  } catch (e) {
    options.audit({ action: "deny", name: cred.name, reason: "SPAWN_FAILED", commandDigest: digest, threadId: req.threadId });
    const msg = (e as Error)?.message || String(e);
    return { id: req.id, ok: false, error: `SPAWN_FAILED: ${msg}` };
  }
}

/** 命令摘要（审计用；不含参数原文，避免把机密写进日志）。 */
function commandDigest(command: string): string {
  // 简单稳定摘要：长命令只留前 40 字符 + 长度，足够人回溯，不足以复原机密。
  const head = command.replace(/\s+/g, " ").slice(0, 40);
  return `${head}${command.length > 40 ? "…" : ""} (${command.length})`;
}

/** 清理超期回执（主进程定时调用）。 */
export function sweepSecretReceipts(outboxDir: string, now: () => number = Date.now): number {
  let removed = 0;
  try {
    for (const file of readdirSync(outboxDir)) {
      if (!file.endsWith(".json")) continue;
      const full = join(outboxDir, file);
      try {
        if (now() - statSync(full).mtimeMs > RECEIPT_TTL_MS) {
          rmSync(full, { force: true });
          removed++;
        }
      } catch {
        /* ignore per-file errors */
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}
