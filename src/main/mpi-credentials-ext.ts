/**
 * MPI 凭据注入 bridge（pi 扩展，加载方式见 credentials-extension.ts）。
 *
 * 干什么
 * ------
 * 主进程在 spawn 这个线程的 pi 时，把「silent 级 + 作用域匹配」的凭据解密后写进
 * **进程环境**（`MPI_SECRET_<NAME>`），并把「变量名 + 引用名 + 用途」的元信息放进
 * `MPI_SECRET_META`（JSON，**不含值**）。本扩展只做一件事：把这批变量名与使用规则
 * 追加到系统提示里，让模型知道「有凭据可用、怎么引用、不许把值打印出来」。
 *
 * 为什么不让主进程改命令参数
 * --------------------------
 * pi 的 `tool_call` hook 只能拦截（`{block:true}`），没有「改写入参」的契约
 * （见 docs/CREDENTIALS-VAULT.md §4.2）——所以展开点只能是执行环境（这里 = 环境变量）。
 *
 * 自包含约束
 * ----------
 * 这个文件会被当**纯文本**写进 userData 再交给 `pi --extension` 执行，**不能 import
 * 项目里的模块**，所以 `buildBlock` 是 `src/shared/credentials.ts` 的拷贝（双语文案以
 * 本文件为准，那边的版本供主进程/测试使用；改动时两处同步）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const META_ENV = "MPI_SECRET_META";
const BLOCKED_ENV = "MPI_SECRET_BLOCKED";
const INBOX_ENV = "MPI_SECRET_INBOX_DIR";
const OUTBOX_ENV = "MPI_SECRET_OUTBOX_DIR";
const THREAD_ENV = "MPI_SECRET_THREAD_ID";
const CONFIG_FILE = process.env.MPI_CHOICE_CONFIG || "";
const MARKER = "<credentials>";

interface SecretMeta {
  env: string;
  name: string;
  hint?: string;
}

/** 与 src/shared/credentials.ts 的 SecretBlocked 同构（本文件自包含，不能 import）。 */
interface SecretBlocked {
  name: string;
  hint?: string;
  reason: "level-confirm" | "level-local-only" | "scope";
}

function language(): "zh" | "en" {
  if (!CONFIG_FILE) return "en";
  try {
    const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return config?.language === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

function readMeta(): SecretMeta[] {
  const raw = process.env[META_ENV];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m: unknown): m is SecretMeta =>
        !!m && typeof m === "object" && typeof (m as SecretMeta).env === "string" && (m as SecretMeta).env.length > 0,
    );
  } catch {
    return [];
  }
}

function readBlocked(): SecretBlocked[] {
  const raw = process.env[BLOCKED_ENV];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b: unknown): b is SecretBlocked => !!b && typeof b === "object" && typeof (b as SecretBlocked).name === "string",
    );
  } catch {
    return [];
  }
}

function blockedReason(b: SecretBlocked, zh: boolean): string {
  if (b.reason === "level-confirm") return zh ? "标记为「远程需确认」，当前会话不能用" : "marked remote-confirm, unavailable here";
  if (b.reason === "level-local-only") return zh ? "标记为「仅本机」，远程会话不能使用" : "marked local-only, refused for remote sessions";
  return zh ? "属于其它项目，当前项目不可用" : "belongs to another project, unavailable here";
}

function buildBlock(meta: SecretMeta[], blocked: SecretBlocked[], zh: boolean): string {
  const lines = meta.map((m) => `- $${m.env}${m.hint ? ` — ${m.hint}` : ""}`);
  const unavailable = blocked.map((b) => `- ${b.name}${b.hint ? `（${b.hint}）` : ""} —— ${blockedReason(b, zh)}`);
  if (zh) {
    return [
      MARKER,
      meta.length
        ? "本机凭据库已把下列凭据注入为环境变量（**值不在对话里，也不要尝试查看**）："
        : "本会话**没有**被注入任何凭据，不要假设密码可用，也不要向用户索要明文。",
      ...(meta.length ? lines : []),
      ...(blocked.length ? ["", "以下凭据存在但当前会话不可用（告诉用户原因，不要尝试，也不要索要明文）：", ...unavailable] : []),
      "",
      "用法与禁令：",
      "- 需要密码/令牌时，直接在命令里引用 `$变量名`（例如 `SSHPASS=$MPI_SECRET_X sshpass -e ssh user@host`）。",
      "- 绝不 `echo` / `printf` / `cat` / 写文件 / 写日志 把这些变量的值暴露出来；不要 `set -x`。",
      "- 不要向用户索要明文密码；用户手动添加或修改凭据在「设置 → 凭据」。",
      "- 变量名拼错会得到空值——失败时报告「该凭据未注入」，不要猜。",
      "</credentials>",
    ].join("\n");
  }
  return [
    MARKER,
    meta.length
      ? "The local credential vault injected these credentials as environment variables (values are **not** in the conversation and must not be inspected):"
      : "**No** credentials were injected into this session; do not assume a password is available and never ask the user for plaintext.",
    ...(meta.length ? lines : []),
    ...(blocked.length
      ? ["", "These credentials exist but are unavailable here (tell the user why; do not attempt, do not ask for plaintext):", ...unavailable]
      : []),
    "",
    "Rules:",
    "- Reference `$VAR` directly in commands (e.g. `SSHPASS=$MPI_SECRET_X sshpass -e ssh user@host`).",
    "- Never `echo` / `printf` / write to files or logs to reveal these values; never `set -x`.",
    "- Never ask the user for a plaintext password; they add or edit credentials in Settings → Credentials.",
    "- A misspelled variable yields an empty value — report that the credential is not injected instead of guessing.",
    "</credentials>",
  ].join("\n");
}

export default function credentialsBridge(pi: any) {
  pi.on("before_agent_start", (event: any) => {
    try {
      const meta = readMeta();
      const blocked = readBlocked();
      if (meta.length === 0 && blocked.length === 0) return; // 没东西可说 → 不碰提示词
      const prompt = String(event?.systemPrompt || "");
      if (prompt.includes(MARKER)) return; // 已经加过
      return { systemPrompt: `${prompt}\n\n${buildBlock(meta, blocked, language() === "zh")}` };
    } catch {
      // 提示词注入永远不能打断 agent 主循环
      return;
    }
  });

  // -------------------------------------------------------------------------
  // mpi_secret_run：用「远程需确认 / 仅本机」级凭据执行一条命令（P2）
  //
  // 值不注入 pi 环境（P1b 只注入 silent 级），所以这类凭据只能走主进程的中介：
  // 本工具先弹一次审批卡片（ctx.ui.select → 桌面与手机都显示，复用现有 ui.request），
  // 批准后把 { 凭据名, 命令 } 丢进收件箱，主进程判策略、解密、带 MPI_SECRET_VALUE
  // 执行，再把输出写回回执箱。值不进对话、不进日志、不进快照。
  // -------------------------------------------------------------------------
  const INBOX = process.env[INBOX_ENV] || "";
  const OUTBOX = process.env[OUTBOX_ENV] || "";
  const THREAD = process.env[THREAD_ENV] || "";

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function waitForReceipt(id: string, timeoutMs: number): Promise<any | null> {
    const file = join(OUTBOX, `${id}.json`);
    const deadline = Date.now() + timeoutMs + 8_000;
    while (Date.now() < deadline) {
      try {
        if (existsSync(file)) {
          const parsed = JSON.parse(readFileSync(file, "utf8"));
          try {
            rmSync(file, { force: true });
          } catch {
            /* 主进程的清扫会收走 */
          }
          return parsed;
        }
      } catch {
        /* 半写文件，再轮询 */
      }
      await sleep(120);
    }
    return null;
  }

  const RunParams = Type.Object({
    credential: Type.String({ description: "Credential reference name as shown in Settings → Credentials (e.g. \"aliyun-prod-root\")." }),
    command: Type.String({
      description:
        "Shell command to run. The credential value is exposed to it as the environment variable $MPI_SECRET_VALUE; never echo that variable.",
    }),
    timeoutSec: Type.Optional(Type.Number({ description: "Timeout in seconds (default 60, max 600)." })),
  });

  pi.registerTool({
    name: "mpi_secret_run",
    label: "Run With Secret",
    description:
      "Run ONE shell command with a saved credential, without the value ever entering the conversation. " +
      "The value is passed to the command as the environment variable MPI_SECRET_VALUE (never echo it). " +
      "The user first sees an approval card (desktop and phone); if they decline, nothing runs. " +
      "Use this for credentials marked 'remote needs confirmation' or 'local only'. Credentials marked 'remote OK' are already " +
      "injected as environment variables — reference those as $MPI_SECRET_<NAME> with the normal bash tool instead.",
    parameters: RunParams,
    executionMode: "sequential",

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const zh = language() === "zh";
      const credential = String(params?.credential || "").trim();
      const command = String(params?.command || "").trim();
      if (!INBOX || !OUTBOX) {
        return {
          content: [
            {
              type: "text",
              text: zh
                ? "凭据执行中介未配置（缺 MPI_SECRET_INBOX_DIR / MPI_SECRET_OUTBOX_DIR），无法执行。请让用户重启 MPI。"
                : "Secret broker is not configured (missing MPI_SECRET_INBOX_DIR / MPI_SECRET_OUTBOX_DIR). Ask the user to restart MPI.",
            },
          ],
        };
      }
      if (!credential || !command) {
        return {
          content: [{ type: "text", text: zh ? "mpi_secret_run 需要 credential 与 command 两个参数。" : "mpi_secret_run needs both credential and command." }],
        };
      }
      if (!ctx?.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: zh
                ? "当前没有可交互界面，无法为这次执行取得确认。请用文字告知用户：需要「远程需确认 / 仅本机」级别的凭据时，请在桌面上手动添加为「远程直接用」，或直接提供替代方案。"
                : "No interactive UI is available, so this run cannot be confirmed. Tell the user in plain text: for confirm/local-only credentials they must either re-level the credential to 'remote OK' or provide an alternative.",
            },
          ],
        };
      }

      // 审批卡片：复用现有 ui.request 通道（桌面弹窗 / 手机全屏卡片）。
      const approve = zh ? "同意执行" : "Approve & run";
      const deny = zh ? "拒绝" : "Deny";
      const preview = command.replace(/\s+/g, " ").slice(0, 160);
      const title = zh
        ? `使用凭据「${credential}」执行命令 —— ${preview}`
        : `Run with credential "${credential}" — ${preview}`;
      let choice: string | null = null;
      try {
        choice = await ctx.ui.select(title, [approve, deny]);
      } catch {
        choice = null;
      }
      if (choice !== approve) {
        return {
          content: [
            {
              type: "text",
              text: zh
                ? `用户未同意（或关闭了确认框），命令没有执行。不要重试，也不要改用其它方式拿到密码；用文字问用户是否要继续。`
                : "The user did not approve (or closed the dialog), so nothing ran. Do not retry and do not look for another way to get the secret; ask the user in plain text.",
            },
          ],
        };
      }

      const timeoutSec = Math.min(Math.max(Number(params?.timeoutSec) || 60, 1), 600);
      const timeoutMs = timeoutSec * 1000;
      const id = randomUUID();
      try {
        mkdirSync(INBOX, { recursive: true });
        const target = join(INBOX, `${id}.json`);
        const tmp = `${target}.${process.pid}.tmp`;
        writeFileSync(
          tmp,
          JSON.stringify({ id, name: credential, command, threadId: THREAD, timeoutMs }),
        );
        const { renameSync } = await import("node:fs");
        renameSync(tmp, target);
      } catch (e) {
        return {
          content: [
            { type: "text", text: zh ? `投递执行请求失败：${(e as Error).message}` : `Could not submit the run request: ${(e as Error).message}` },
          ],
        };
      }

      const receipt = await waitForReceipt(id, timeoutMs);
      if (!receipt) {
        return {
          content: [
            {
              type: "text",
              text: zh
                ? `等待主机执行超时（${timeoutSec}s）。命令可能仍在跑或被中断；不要重复投递同一请求，先问用户。`
                : `Timed out after ${timeoutSec}s waiting for the host. The command may still be running; do not resubmit, ask the user first.`,
            },
          ],
        };
      }
      if (!receipt.ok && receipt.error) {
        const reasons: Record<string, string> = {
          NO_CREDENTIAL: zh ? "没有这个凭据（名字拼错，或已被删除）" : "no such credential (typo or deleted)",
          DENIED_LOCAL_ONLY: zh ? "该凭据标记为「仅本机」，远程会话不能使用" : "that credential is local-only and refused for remote sessions",
          EMPTY_COMMAND: zh ? "命令为空" : "empty command",
        };
        const why = reasons[String(receipt.error)] || String(receipt.error);
        return {
          content: [{ type: "text", text: zh ? `执行被拒绝：${why}` : `Run refused: ${why}` }],
        };
      }
      const body = [
        `exitCode: ${receipt.exitCode ?? "null"}`,
        receipt.stdout ? `--- stdout ---\n${receipt.stdout}` : "",
        receipt.stderr ? `--- stderr ---\n${receipt.stderr}` : "",
        receipt.redacted
          ? zh
            ? "（输出里出现过凭据值，已替换成 ***；不要尝试绕过这一点去复读它。）"
            : "(The credential value appeared in the output and was replaced with ***; do not try to recover it.)"
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text: body }] };
    },
  });
}
