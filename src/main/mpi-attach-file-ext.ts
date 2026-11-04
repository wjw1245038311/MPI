/**
 * MPI 附件下行 bridge for pi (loaded via --extension, see attach-file-extension.ts).
 *
 * Gives the agent `mpi_attach_file`: hand one file over to the conversation so the
 * desktop shows a card and paired phones / PWA can actually download it. The
 * extension NEVER touches the attachment library — it drops a request into an inbox
 * that the main process ingests (single writer of index.json), then polls the
 * matching receipt for the ready-made reference text. Same shape as mpi-todo-ext.
 *
 * Env (set by pi-bridge at spawn):
 *   MPI_ATTACH_INBOX_DIR    absolute path to <userData>/attach-file-inbox/
 *   MPI_ATTACH_OUTBOX_DIR   absolute path to <userData>/attach-file-outbox/
 *   MPI_WORKSPACE_ROOT      optional MyWorkspace root (widens the no-approval area)
 *   MPI_ATTACH_CONFIG_FILE  <userData>/config.json, read for the UI language
 *   MPI_ATTACH_SESSION_FILE this thread's session JSONL (diagnostics only)
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const INBOX_DIR = process.env.MPI_ATTACH_INBOX_DIR || "";
const OUTBOX_DIR = process.env.MPI_ATTACH_OUTBOX_DIR || "";
const WORKSPACE_ROOT = process.env.MPI_WORKSPACE_ROOT || "";
const CONFIG_FILE = process.env.MPI_ATTACH_CONFIG_FILE || "";
const SESSION_FILE = process.env.MPI_ATTACH_SESSION_FILE || "";

/**
 * 当前会话的 session JSONL（**以 pi 运行时为准**）。
 *
 * 为什么不能只信 env（2026-11-04 真机）：`MPI_ATTACH_SESSION_FILE` 是**桥启动时**
 * 的快照，而桥会被复用（新建/继续会话不会换进程）。会话换过之后它指向的就是旧文件，
 * 后果是两层错位：
 *   ① 主进程台账把附件记在**别的会话**名下 → 当前会话的快照永远查不到（日志指纹：
 *      `attach-block fallback keys=1 hit=0`，卡片就是不出来）；
 *   ② 补拉信号被算到另一个 threadId 上（日志：`remoteThread=7GKetH1…` 而手机订的是
 *      `DbgkKa_…`）。
 * `ctx.sessionManager.getSessionFile()` 是 pi 在**调用这一刻**的权威值，故优先用它。
 */
function currentSessionFile(ctx: any): string {
  try {
    const fromCtx = ctx?.sessionManager?.getSessionFile?.();
    if (typeof fromCtx === "string" && fromCtx.trim()) return fromCtx.trim();
  } catch {
    /* 运行时没这个接口 → 退回 env */
  }
  return SESSION_FILE;
}

/** UI language, re-read per call so a language switch takes effect at once. */
function language(): "zh" | "en" {
  try {
    const raw = CONFIG_FILE ? readFileSync(CONFIG_FILE, "utf8") : "";
    return (JSON.parse(raw)?.language as string) === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

/** Keep in sync with ATTACH_FILE_MAX_BYTES in attach-file-core.ts. */
const MAX_BYTES = 128 * 1024 * 1024;
/** Main process hashes + stores the file; 128MB is ~1-2s locally, so 30s is generous. */
const RECEIPT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

function configured(): boolean {
  return !!INBOX_DIR && !!OUTBOX_DIR;
}

// ---- path judgement (mirror of attach-file-core.ts) -------------------------
// The extension runs inside the pi subprocess and cannot import main-process
// modules, so this small block duplicates core logic — same convention as
// SAFE_TOOLS in permission-gate-ext.ts. scripts/test-attach-file.mjs asserts both
// implementations agree on a shared case table, so drift fails CI loudly.

function normalizePath(value: string): string {
  const slash = String(value || "").trim().replace(/\\/g, "/");
  const drive = slash.match(/^([a-zA-Z]:)/)?.[1] || "";
  const body = drive ? slash.slice(drive.length) : slash;
  const rooted = !!drive || body.startsWith("/");
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!rooted) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  return (drive ? `${drive}/` : rooted ? "/" : "") + parts.join("/");
}

/**
 * 审批卡上显示的位置：`桌面/测试.docx` 这种「一级目录 + 文件名」。
 *
 * 为什么不直接给绝对路径（2026-11-04 真机）：远程通道会把卡片正文里的路径
 * 脱敏成 `[path]`（见 remote/path-redact.ts），于是手机上只看到
 *
 *     把文件发送到会话？
 *     [path]
 *     0.01 MB
 *
 * ——用户在批准一个自己看不到的东西，根本无从判断。这里改给「可读位置」：
 * 保留文件名与它所在的**最后一级目录**，既让用户认得出是哪个文件（这是审批卡的
 * 唯一目的），又不把整条主机目录结构递到手机上（脱敏的本意）。
 *
 * 常见系统目录换成中文叫法：Windows 上 `C:\\Users\\x\\Desktop` 里的 `Desktop`
 * 叫「桌面」比叫 `Desktop` 顺手（与资源管理器一致）。
 */
function displayLocation(abs: string): string {
  const parts = normalizePath(abs).split("/").filter(Boolean);
  if (!parts.length) return abs;
  const file = parts[parts.length - 1];
  const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
  if (!parent) return file;
  const friendly: Record<string, string> = {
    desktop: "桌面",
    downloads: "下载",
    documents: "文档",
    pictures: "图片",
    music: "音乐",
    videos: "视频",
    temp: "临时",
    tmp: "临时",
  };
  const named = friendly[parent.toLowerCase()] || parent;
  return `${named}/${file}`;
}

function resolveAgentPath(raw: string, cwd: string): string {
  const value = String(raw || "").trim().replace(/^["']+|["']+$/g, "");
  const msys = value.match(/^\/([a-zA-Z])\/(.+)$/);
  if (msys) return normalizePath(`${msys[1].toUpperCase()}:/${msys[2]}`);
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/")) return normalizePath(value);
  return normalizePath(`${cwd.replace(/\\/g, "/")}/${value}`);
}

function findWorkspaceRoot(cwd: string, configuredRoot: string): string | null {
  if (configuredRoot.trim()) return normalizePath(configuredRoot);
  const parts = normalizePath(cwd).split("/");
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].toLowerCase() === "myworkspace") return normalizePath(parts.slice(0, i + 1).join("/"));
  }
  return null;
}

/** No-approval area: session cwd + <workspace>/Work/tempfile + <workspace>/Share. */
function allowedRoots(cwd: string): string[] {
  const roots = [normalizePath(cwd)];
  const root = findWorkspaceRoot(cwd, WORKSPACE_ROOT);
  if (root) {
    roots.push(normalizePath(`${root}/Work/tempfile`));
    roots.push(normalizePath(`${root}/Share`));
  }
  return [...new Set(roots.filter(Boolean))];
}

function isWithinRoots(path: string, roots: string[]): boolean {
  const target = normalizePath(path).toLowerCase().replace(/\/+$/, "");
  for (const raw of roots) {
    const root = normalizePath(raw).toLowerCase().replace(/\/+$/, "");
    if (!root) continue;
    if (target === root || target.startsWith(`${root}/`)) return true;
  }
  return false;
}

// ---- inbox / outbox round trip ---------------------------------------------

interface Receipt {
  id: string;
  ok: boolean;
  text?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for the main process to ingest our request. null = timed out. */
async function waitForReceipt(id: string): Promise<Receipt | null> {
  const file = join(OUTBOX_DIR, `${id}.json`);
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Receipt;
        // Take it out of the outbox: leaving it around only feeds the TTL sweep.
        try {
          rmSync(file, { force: true });
        } catch {
          /* main's sweep collects it if this fails */
        }
        return parsed;
      }
    } catch {
      /* half-written file — poll again */
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

const Params = Type.Object({
  path: Type.String({
    description:
      "File to hand over. Absolute (E:/a/b.pdf or Git Bash /e/a/b.pdf) or relative to this session's working directory.",
  }),
  label: Type.Optional(
    Type.String({ description: "Display name shown in the conversation card (defaults to the file name)." }),
  ),
  note: Type.Optional(Type.String({ description: "One short line telling the user what this file is." })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mpi_attach_file",
    label: "Attach File",
    description:
      "Send a real file into this MPI conversation as a downloadable attachment. " +
      "Use when the user asks you to hand something over (a report, an archive, audio, an installer) and may be " +
      "reading on a phone or another device — desktop shows a clickable card, paired phones/PWA can download it. " +
      "Prefer this over pasting a path when the user will not have access to this machine. " +
      "Files inside the project folder, Work/tempfile and Share go straight through; anything else asks the user first. " +
      "Calling this tool IS the send action: MPI stores the file, attaches the card and syncs it to every paired " +
      "device on its own. You only need the file's name/path to call it — after it returns, just continue the " +
      "conversation normally. Never write any file reference markup (<file … />) or base64 into your reply; " +
      "the attachment is not text you have to reproduce.",
    parameters: Params,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
      if (!configured()) {
        return { content: [{ type: "text", text: "File attach is not configured (missing MPI_ATTACH_INBOX_DIR / MPI_ATTACH_OUTBOX_DIR)." }] };
      }
      const cwd = process.cwd();
      const abs = resolveAgentPath(String(params.path || ""), cwd);
      const label = String(params.label || "").trim() || abs.split("/").filter(Boolean).pop() || "附件";

      let stats;
      try {
        stats = statSync(abs);
      } catch {
        return { content: [{ type: "text", text: `Error: file not found: ${abs}` }] };
      }
      if (!stats.isFile()) return { content: [{ type: "text", text: `Error: not a regular file: ${abs}` }] };
      if (stats.size <= 0) return { content: [{ type: "text", text: `Error: file is empty: ${abs}` }] };
      if (stats.size > MAX_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds the 128MB per-attachment limit. Share it another way (Seafile / mail) or split it up.`,
            },
          ],
        };
      }

      // Outside the no-approval area we need one explicit yes. Without UI (automation,
      // unattended run) there is nobody to ask → refuse rather than assume consent.
      let approved = true;
      if (!isWithinRoots(abs, allowedRoots(cwd))) {
        if (!ctx?.hasUI) {
          return {
            content: [
              {
                type: "text",
                text: `Refused: ${abs} is outside this session's workspace and there is no UI to ask for approval. Move the file into the project folder, Work/tempfile or Share first.`,
              },
            ],
          };
        }
        const zh = language() === "zh";
        const note = String(params.note || "").trim().slice(0, 200);
        const size = `${(stats.size / 1024 / 1024).toFixed(2)} MB`;
        // 显示「桌面/测试.docx」而不是绝对路径：绝对路径会在远程通道被脱敏成 `[path]`，
        // 用户就看不见自己要批准什么了（见 displayLocation 的注释）。
        const where = displayLocation(abs);
        const title = zh
          ? [`把文件发送到会话？`, where, size, ...(note ? [note] : []), "", "该文件不在本会话工作区内；发送后，已配对的手机/PWA 都能下载它。"].join("\n")
          : [
              `Send this file into the conversation?`,
              where,
              size,
              ...(note ? [note] : []),
              "",
              "This file is outside the session workspace. Once sent, every paired phone/PWA can download it.",
            ].join("\n");
        const yes = zh ? "允许发送" : "Allow sending";
        const no = zh ? "取消" : "Cancel";
        const choice = await ctx.ui.select(title, [yes, no]);
        approved = choice === yes;
        if (!approved) {
          return { content: [{ type: "text", text: `The user declined to send ${abs}. Do not retry it silently.` }] };
        }
      }

      const id = randomUUID().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
      try {
        mkdirSync(INBOX_DIR, { recursive: true });
        writeFileSync(
          join(INBOX_DIR, `${id}.json`),
          JSON.stringify({
            id,
            path: abs,
            cwd,
            label,
            ...(String(params.note || "").trim() ? { note: String(params.note).trim().slice(0, 500) } : {}),
            ...(currentSessionFile(ctx) ? { sessionFile: currentSessionFile(ctx) } : {}),
            // Only meaningful when outside the roots; inside them main re-checks anyway.
            approved,
          }),
        );
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to queue the file: ${String(e instanceof Error ? e.message : e)}` }] };
      }

      const receipt = await waitForReceipt(id);
      if (!receipt) {
        return { content: [{ type: "text", text: `Timed out waiting for MPI to store ${abs}. The file was not sent.` }] };
      }
      if (!receipt.ok || !receipt.text) {
        return { content: [{ type: "text", text: `Could not send the file: ${receipt.error || "unknown error"}` }] };
      }
      // 回执只说「发完了」——**不回 XML**（2026-11-04 设计修正）。
      //
      // 以前这里回的是「Put this reference verbatim into your reply so the card renders」
      // 加一段 `<file … attach="media" … />`，于是模型真的会把整段标记写进回答；
      // 主机的剥除器只要漏一条路径（事件通道的助手正文、thinking…），用户就会在手机上
      // 看到一大段 XML（真机反复复现）。
      //
      // 现在的分工：**发送与出卡完全由 MPI 内部完成**——引用已经由主进程写进对象库并
      // 挂到本会话（走 tool 结果的内部通道，快照据此生成文件块），模型只需要知道
      // 「发成了 / 失败 / 叫什么名字」。这样它**手里根本没有可抄的标记**。
      const sizeText = receipt.size ? ` (${(receipt.size / 1024).toFixed(1)} KB)` : "";
      // 机器元数据（**给主机看的**，不是给模型转述的）：内部 JSON 里带 name/label/size，
      // 快照从 tool 结果里把它读出来生成文件卡片。
      //
      // 为什么不能用台账（attachFileStored）：入库是异步的（watch + 1s 轮询），而快照
      // 在工具返回时就会生成。2026-11-04 实测：快照先跑（keys=0 hit=0），登记 45 秒后
      // 才到——卡片就丢了。tool 结果本身就是同行到达的，时序上才靠得住。
      // 它长得不像 `<file …/>`，模型不会把它当成「要贴进回复的东西」。
      const meta = JSON.stringify({
        mpi_attachment: {
          ...(receipt.key ? { name: receipt.key } : {}),
          label,
          ...(receipt.size ? { size: receipt.size } : {}),
        },
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Sent "${label}"${sizeText} into this conversation. MPI attached it already — every paired phone/PWA can download it now. ` +
              `The attachment card is generated by MPI; just continue the conversation normally (mentioning the file name is fine).\n` +
              meta,
          },
        ],
      };
    },
  });
}
