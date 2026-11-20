/**
 * MPI 自更新 bridge for pi: 给 agent 一个 `mpi_update_app` 工具。
 *
 * 为什么需要（2026-11-05 用户需求）：「加一个更新的指令，方便我在手机端控制其它设备
 * 自动更新」。手机只能发对话，所以「指令」必须是 agent 能执行的东西：
 *
 *   user（手机）：「把这台机器上的 MPI 更新一下」
 *   agent      → mpi_update_app                       ← 本扩展
 *               → 主进程 inbox（查 / 下 / 装，electron-updater 只存在于主进程）
 *               ← 回执（已在最新版 / 正在下载 / 正在安装 / 失败原因）
 *   agent      → 把回执转述给用户
 *
 * 扩展不碰更新逻辑：它只落一个请求文件并等回执（与 mpi_attach_file 同一套「扩展只写信、
 * 主进程是唯一执行者」的约定）。安装会重启应用、连带杀掉本 pi 进程，所以主进程**先写
 * 回执再延迟安装**，保证模型能先把话说出去。
 *
 * Env（pi-bridge 在 spawn 时注入）：
 *   MPI_UPDATE_INBOX_DIR    <userData>/app-update-inbox/
 *   MPI_UPDATE_OUTBOX_DIR   <userData>/app-update-outbox/
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const INBOX_DIR = process.env.MPI_UPDATE_INBOX_DIR || "";
const OUTBOX_DIR = process.env.MPI_UPDATE_OUTBOX_DIR || "";

/** 查更新 + 可能下载：30s 内拿不到「发现了什么」就当失败（下载本身在后台继续）。 */
const RECEIPT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

interface Receipt {
  id: string;
  ok: boolean;
  state: "up-to-date" | "downloading" | "downloaded" | "installing" | "restarting" | "error";
  /** 主进程回写执行的动作（旧回执没有这个字段，视为 update）。 */
  action?: "update" | "restart";
  current?: string;
  latest?: string;
  message?: string;
}

/** 与 update-request.ts 的 UpdateAction 保持一致（扩展不能 import 主进程模块）。 */
type Action = "update" | "restart";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 等主进程的第一份回执（查完就能回话；下载/安装在后台继续）。 */
async function waitForReceipt(id: string): Promise<Receipt | null> {
  const file = join(OUTBOX_DIR, `${id}.json`);
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Receipt;
        try {
          rmSync(file, { force: true });
        } catch {
          /* ignore */
        }
        return parsed;
      }
    } catch {
      /* 半截文件：稍后再读 */
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

/** 回执 → 给模型的一句话（与主进程 update-request.ts 的口径一致，避免两边措辞漂移）。 */
function receiptText(receipt: Receipt): string {
  const current = receipt.current ? ` (current v${receipt.current})` : "";
  switch (receipt.state) {
    case "restarting":
      return `MPI is restarting now${current}. Nothing was installed — this is a plain restart, so config files are re-read. The conversation reconnects on its own in a few seconds.`;
    case "up-to-date":
      return `MPI is already up to date${current}. Nothing to install.`;
    case "downloading":
      return `Found MPI v${receipt.latest}${current}. Downloading in the background and installing automatically — the app restarts when it is done, so this conversation may briefly disconnect. Tell the user they do not need to do anything.`;
    case "downloaded":
      return `Downloaded MPI v${receipt.latest}${current} but did not install it (install=false). The user can install it from Settings → About.`;
    case "installing":
      return `MPI v${receipt.latest} has been downloaded and is installing now — the app is restarting. The conversation reconnects on its own.`;
    case "error":
      if (receipt.action === "restart") {
        return `MPI restart failed${current}: ${receipt.message || "unknown error"}. The app is still running on the same version.`;
      }
      return `MPI update failed${current}: ${receipt.message || "unknown error"}. Nothing was installed.`;
    default:
      return receipt.message || "MPI update finished.";
  }
}

const Params = Type.Object({
  restart: Type.Optional(
    Type.Boolean({
      description:
        "Restart the MPI app instead of updating it (no version change, no network). Use it when a config change only takes effect after a restart — e.g. models.json providers, maxTokens, or an app/service registry edit — and the user cannot click “立即重启 MPI” themselves (phone, web client, automation).",
    }),
  ),
  install: Type.Optional(
    Type.Boolean({
      description:
        "Install and restart after downloading (default true). Set false only to download without restarting — use it when the user wants to install manually later. Ignored when restart=true.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description:
        "Optional one-line reason recorded in the diag log and echoed back (e.g. “models.json provider edited”). Keep it short; it is for the audit trail, not for the user.",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mpi_update_app",
    label: "Update or restart MPI",
    description:
      "Update or restart the MPI desktop app **on the machine hosting this conversation**.\n" +
      "Two modes:\n" +
      "· update (default): check for a newer version, download it and (by default) install + restart. Use it whenever the user asks to update MPI / 更新这台设备 / 把这个版本的 MPI 升级一下 — including requests from a paired phone or the web client, which cannot reach this machine any other way.\n" +
      "· restart=true: only restart the app, no version change and no network. Use it when the user edited config that is read at startup (models.json providers / maxTokens / extension or app-service registry) and wants it to take effect — 重启一下 / 重启生效 / 让配置生效 / restart to apply. Do NOT use it for ordinary “my app hung” complaints before trying the smaller fixes, and do not restart while a long turn is mid-flight if the user only wanted the file edited.\n" +
      "Both modes only affect THIS host, never other machines: if the user mentions another device, ask them to switch to that device's conversation first. " +
      "The app restarts either way, so this conversation briefly disconnects and reconnects on its own. Always tell the user that the restart is happening and that they need to do nothing.",
    parameters: Params,

    async execute(_toolCallId, params) {
      if (!INBOX_DIR || !OUTBOX_DIR) {
        return { content: [{ type: "text", text: "MPI update bridge is not configured (missing MPI_UPDATE_INBOX_DIR / MPI_UPDATE_OUTBOX_DIR)." }] };
      }
      const id = randomUUID().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
      const action: Action = params?.restart === true ? "restart" : "update";
      const install = params?.install !== false;
      const reason = typeof params?.reason === "string" ? params.reason.slice(0, 200) : undefined;
      try {
        mkdirSync(INBOX_DIR, { recursive: true });
        writeFileSync(
          join(INBOX_DIR, `${id}.json`),
          JSON.stringify({ id, action, install, ...(reason ? { reason } : {}) }),
          "utf8",
        );
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Failed to queue the ${action} request: ${String(error instanceof Error ? error.message : error)}` },
          ],
        };
      }

      const receipt = await waitForReceipt(id);
      if (!receipt) {
        return {
          content: [
            {
              type: "text",
              text:
                `Timed out waiting for MPI to answer the ${action} request. Nothing is known about the outcome — do not claim it succeeded; ` +
                "the user can retry, or check Settings → About for the current version.",
            },
          ],
        };
      }
      return { content: [{ type: "text", text: receiptText(receipt) }] };
    },
  });
}
