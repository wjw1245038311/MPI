/**
 * 「让**当前这台**设备更新 MPI」的请求/回执**纯逻辑**（无 electron）。
 *
 * 为什么要有这条通道（2026-11-05 用户需求）：手机端控制别的设备更新——用户的原话是
 * 「增加一个更新的指令，方便我在手机端控制其它设备自动更新」。手机只能发对话，所以
 * 指令必须能被 **agent** 读懂并执行：pi 子进程里的扩展写一份请求进 inbox，主进程
 * （唯一能碰 electron-updater 的一侧）去查/下/装，再把回执写回去给模型转述。
 *
 * 与 attach-file 同一套形状（扩展只落文件、主进程是单一执行者），但请求小得多：
 * 一个 id + 是否安装。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 请求目录（主进程与扩展各拿一份，由 pi-bridge 注入子进程 env）。 */
export interface UpdateDirs {
  inboxDir: string;
  outboxDir: string;
}

export function ensureUpdateDirs(userDataDir: string): UpdateDirs {
  const inboxDir = join(userDataDir, "app-update-inbox");
  const outboxDir = join(userDataDir, "app-update-outbox");
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(outboxDir, { recursive: true });
  return { inboxDir, outboxDir };
}

/** 回执里可出现的状态（客户端只用来措辞，不参与判定）。 */
export type UpdateState = "up-to-date" | "downloading" | "downloaded" | "installing" | "error";

export interface UpdateRequest {
  id: string;
  /** 下完是否直接安装并重启（默认 true：用户要的是「自动更新」）。 */
  install: boolean;
}

export interface UpdateReceipt {
  id: string;
  ok: boolean;
  state: UpdateState;
  /** 当前版本（总是有）。 */
  current?: string;
  /** 目标版本（有更新时才有）。 */
  latest?: string;
  message?: string;
}

/** 请求校验：只认带 id 的对象，多余字段忽略（缺 install 视为 true）。 */
export function normalizeUpdateRequest(raw: unknown): UpdateRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id || id.length > 64) return null;
  return { id, install: value.install !== false };
}

/** 回执 → 给模型看的一句话（英文，与各工具的 agent 侧文案一致）。 */
export function updateReceiptText(receipt: UpdateReceipt): string {
  const current = receipt.current ? ` (current v${receipt.current})` : "";
  switch (receipt.state) {
    case "up-to-date":
      return `MPI is already up to date${current}. Nothing to install.`;
    case "downloading":
      return `Found MPI v${receipt.latest}${current}. Downloading and will install automatically — the app restarts when it is done, so the conversation may briefly disconnect.`;
    case "downloaded":
      return `Downloaded MPI v${receipt.latest}${current}, but installation was skipped (install=false). It will be installed from Settings → About the next time you ask.`;
    case "installing":
      return `MPI v${receipt.latest} is installed — the app is restarting now. The conversation reconnects on its own afterwards.`;
    case "error":
      return `MPI update failed${current}: ${receipt.message || "unknown error"}. Nothing was installed.`;
    default:
      return receipt.message || "MPI update finished.";
  }
}

/** 回执写盘（主进程调用；失败不影响更新本身）。 */
export function writeUpdateReceipt(dirs: UpdateDirs, receipt: UpdateReceipt): void {
  try {
    writeFileSync(join(dirs.outboxDir, `${receipt.id}.json`), JSON.stringify(receipt), "utf8");
  } catch {
    /* 回执写不进去时扩展会超时——比静默改坏状态好，至少模型会说「没收到回执」 */
  }
}

export interface IngestUpdateOptions extends UpdateDirs {
  /** 处理一条请求；实现方负责在完成/失败时写回执。 */
  onRequest: (request: UpdateRequest) => void;
  /** 处理过的请求立刻删除（默认）——重复巡检不会重复触发更新。 */
  now?: number;
}

/**
 * 扫一遍收件箱，把请求交给 `onRequest` 并**立即删除**该请求文件。
 *
 * 为什么先删再执行：更新会重启应用，重复触发没有意义；文件留着只会让下一轮巡检再触发一次。
 */
export function ingestUpdateRequests(options: IngestUpdateOptions): number {
  let handled = 0;
  let names: string[] = [];
  try {
    names = readdirSync(options.inboxDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(options.inboxDir, name);
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // 半截写入（扩展正在写）→ 下一轮再看；超过 1 分钟的直接清掉。
      try {
        if (Date.now() - statSync(file).mtimeMs > 60_000) rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    const request = normalizeUpdateRequest(raw);
    try {
      rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
    if (!request) continue;
    handled += 1;
    options.onRequest(request);
  }
  return handled;
}
