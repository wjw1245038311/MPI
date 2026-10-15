/**
 * 附件下行的**主进程侧收件箱**（agent → 对象库 → 引用文本）。
 *
 * 为什么走文件而不是 IPC：pi 扩展跑在 pi 子进程里，拿不到 electron IPC。沿用待办任务
 * （mpi-todo-ext + todos-inbox）的既有模式——扩展只往 inbox 丢一个 JSON，主进程是对象库
 * 的**唯一写入者**（`chat-attachment-store` 维护 index.json，跨进程并发写会把它写坏），
 * 处理结果再写进 outbox 等扩展取回。
 *
 * 目录：<userData>/attach-file-inbox/ 与 <userData>/attach-file-outbox/
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mediaRefEnvelope } from "./remote/video-refs";
import { ATTACH_FILE_MAX_BYTES, checkAttachRequest, guessMimeType, type AttachFileReceipt, type AttachFileRequest } from "./attach-file-core";

/** 回执保留时长：扩展正常几秒就取走；超时说明 agent 那一轮已经中断。 */
const RECEIPT_TTL_MS = 30 * 60 * 1000;

export interface AttachFileDirs {
  inboxDir: string;
  outboxDir: string;
}

/** 建好两个目录并返回路径（幂等）。 */
export function ensureAttachFileDirs(userDataDir: string): AttachFileDirs {
  const inboxDir = join(userDataDir, "attach-file-inbox");
  const outboxDir = join(userDataDir, "attach-file-outbox");
  for (const dir of [inboxDir, outboxDir]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* already there */
    }
  }
  return { inboxDir, outboxDir };
}

/** 对象库写入器（注入以便单测：真实实现是 chat-attachment-store 的 storeObject）。 */
export type StoreObjectFn = (args: { sourcePath: string; label?: string; mime?: string }) => { abs: string; name: string; size: number } | null;

export interface IngestAttachFileOptions {
  inboxDir: string;
  outboxDir: string;
  storeObject: StoreObjectFn;
  /** workspace 根（env MPI_WORKSPACE_ROOT），影响白名单判定 */
  workspaceRoot?: string;
  maxBytes?: number;
  now?: () => number;
}

function writeReceipt(outboxDir: string, receipt: AttachFileReceipt): void {
  // 先写临时名再 rename：扩展在轮询里读到的永远是完整文件（Windows 上 rename 可覆盖）。
  const target = join(outboxDir, `${receipt.id}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(receipt));
    renameSync(tmp, target);
  } catch {
    /* disk full / file vanished — the agent gets a timeout instead, which is honest */
  }
}

function dropQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

/** 内容寻址时对象名本身就是 SHA-256，引用要带上 key（客户端据此按需拉 + 跨会话去重）。 */
const CONTENT_KEY_RE = /^[a-f0-9]{64}$/;

/** 处理单个请求文件；无论成败都会留下回执并删除请求。 */
function ingestOne(file: string, opts: IngestAttachFileOptions): boolean {
  let req: AttachFileRequest;
  try {
    req = JSON.parse(readFileSync(file, "utf8")) as AttachFileRequest;
  } catch {
    return false; // half-written JSON — retry on the next sweep
  }
  const id = String(req?.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!id) {
    dropQuietly(file);
    return false;
  }
  const maxBytes = opts.maxBytes ?? ATTACH_FILE_MAX_BYTES;
  const fail = (error: string): boolean => {
    writeReceipt(opts.outboxDir, { id, ok: false, error });
    dropQuietly(file);
    return true;
  };

  // 白名单外必须带 approved（扩展弹卡通过后写入）。注意：approved 由扩展写、理论上可被
  // 同一会话的 bash 伪造——本功能的边界是「知情确认」而非沙箱，理由见 attach-file-core 头注。
  const verdict = checkAttachRequest(req, { requireInsideRoots: !req.approved, workspaceRoot: opts.workspaceRoot });
  if (!verdict.ok || !verdict.abs) return fail(verdict.error || "attach request rejected.");

  let stats;
  try {
    stats = statSync(verdict.abs);
  } catch {
    return fail(`file not found: ${verdict.abs}`);
  }
  if (!stats.isFile()) return fail(`not a regular file: ${verdict.abs}`);
  if (stats.size <= 0) return fail(`file is empty: ${verdict.abs}`);
  if (stats.size > maxBytes) {
    return fail(`file is ${(stats.size / 1024 / 1024).toFixed(1)}MB, over the ${(maxBytes / 1024 / 1024).toFixed(0)}MB per-attachment limit.`);
  }

  const mime = guessMimeType(verdict.abs, verdict.label);
  const stored = opts.storeObject({ sourcePath: verdict.abs, label: verdict.label, mime });
  if (!stored) return fail("could not store the file in MPI's attachment library (disk error or storage over quota).");

  // 引用文本是唯一真源：交给 mediaRefEnvelope 生成，格式与用户上传附件完全一致，
  // 于是 splitMediaRefs / 作用域白名单 / GC live-set 全都自动认得它。
  const isKey = CONTENT_KEY_RE.test(stored.name);
  const text = mediaRefEnvelope({
    name: stored.name,
    abs: stored.abs,
    kind: "file",
    ...(isKey ? { key: `sha256:${stored.name.toLowerCase()}` } : {}),
    label: verdict.label,
    size: stored.size,
  });
  writeReceipt(opts.outboxDir, { id, ok: true, text, size: stored.size, ...(isKey ? { key: stored.name } : {}) });
  dropQuietly(file);
  return true;
}

/** 清掉没人取走的旧回执（agent 那一轮中断/被取消时留下）。 */
function sweepOutbox(outboxDir: string, now: number): void {
  let names: string[] = [];
  try {
    names = readdirSync(outboxDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = join(outboxDir, name);
    try {
      if (now - statSync(full).mtimeMs > RECEIPT_TTL_MS) dropQuietly(full);
    } catch {
      /* vanished between readdir and stat */
    }
  }
}

/**
 * 处理 inbox 里所有请求，返回本次成功落回执的数量。
 * watch 与轮询共用；重复调用无害（请求文件处理完即删）。
 */
export function ingestAttachFileRequests(opts: IngestAttachFileOptions): number {
  const now = opts.now?.() ?? Date.now();
  sweepOutbox(opts.outboxDir, now);
  let names: string[] = [];
  try {
    names = readdirSync(opts.inboxDir).filter((n) => n.endsWith(".json"));
  } catch {
    return 0;
  }
  let done = 0;
  for (const name of names) {
    try {
      if (ingestOne(join(opts.inboxDir, name), opts)) done += 1;
    } catch (e) {
      // 单个请求出错不能拖垮整批（否则一个坏文件让附件通道永久停摆）。
      const id = name.replace(/\.json$/, "");
      writeReceipt(opts.outboxDir, { id, ok: false, error: `attach failed: ${String(e instanceof Error ? e.message : e)}` });
      dropQuietly(join(opts.inboxDir, name));
      done += 1;
    }
  }
  return done;
}

/** 扩展用的请求文件名生成（id 同时是回执名，两边只用它对齐）。 */
export const newAttachRequestId = (): string => randomUUID().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);

/** 供测试与诊断：目录是否已就绪。 */
export const attachDirsReady = (dirs: AttachFileDirs): boolean => existsSync(dirs.inboxDir) && existsSync(dirs.outboxDir);
