/**
 * 聊天附件的**持久落盘区**（视频这类「要在对话框里长期可播」的媒体）。
 *
 * 为什么不用 `%TEMP%/mpi-clipboard`：那是 `stageClipboardFile` 的通用粘贴暂存区，属于
 * 「随时可清理」的语义（系统存储清理、清理工具都会动它）。而消息里的视频引用是**会话历史
 * 的一部分**——文件没了，历史里那条消息就只能退化成占位卡片（2026-09-28 真机已踩到：
 * 「提示过期被清理了」）。所以视频单独存到 `<userData>/chat-attachments/`。
 *
 * 目录策略：只收视频（内联播放用），单个 ≤ CHAT_VIDEO_MAX_BYTES（超过的仍走普通文件引用，
 * 不进这里）；总量超过 MAX_DIR_BYTES 时按 mtime 从旧到新删到限额内。
 */
import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { REMOTE_VIDEO_FILE_MAX_BYTES, VIDEO_EXT_BY_MIME } from "./remote/video-refs";

export const CHAT_ATTACHMENT_DIR = "chat-attachments";
/** 目录总量上限（超出按 mtime 删最旧的）。 */
const MAX_DIR_BYTES = 300 * 1024 * 1024;

const VIDEO_EXTS = new Set([".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi"]);

/** 是不是「可内联播放的视频」文件（按扩展名）。 */
export const isVideoFile = (name: string): boolean => VIDEO_EXTS.has(extname(name).toLowerCase());

/** 文件名白名单（与 chatatt:// 协议共用）：uuid-名字.ext，不含任何路径成分。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;

function dir(create = true): string {
  const target = join(app.getPath("userData"), CHAT_ATTACHMENT_DIR);
  if (create) mkdirSync(target, { recursive: true });
  return target;
}

/** 统一命名：`<uuid>-<原名>`（uuid 保证不撞名，原名保留可读性）。 */
function stagedName(originalName: string): string {
  const safe = basename(String(originalName || "video.mp4"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 120) || "video.mp4";
  return `${randomUUID()}-${safe}`;
}

/**
 * 手机端发来的视频（base64，已在内存里）→ 落盘。
 * 超过 CHAT_VIDEO_MAX_BYTES 直接抛错（调用方本来就已按同一上限校验过）。
 */
export function stageChatVideoBytes(args: { name?: string; mimeType?: string; data: string }): { abs: string; name: string; size: number } {
  const bytes = Buffer.from(String(args.data || ""), "base64");
  if (!bytes.length) throw new Error("video attachment is empty");
  if (bytes.length > REMOTE_VIDEO_FILE_MAX_BYTES) throw new Error("video attachment is too large");
  const extension = VIDEO_EXT_BY_MIME[String(args.mimeType || "").toLowerCase()] || ".mp4";
  const name = stagedName(args.name || `video-${Date.now()}${extension}`);
  const abs = join(dir(), name);
  writeFileSync(abs, bytes, { flag: "wx" });
  return { abs, name, size: bytes.length };
}

/**
 * 桌面端选/拖进来的视频文件 → **复制**进附件区（原文件保持不动），返回新名字。
 *
 * 复制而不是引用原路径：① 原文件可能被移动/删除，而会话历史要能长期回看；
 * ② `chatatt://` 只服务这一个目录，不允许渲染层随意指路径。
 */
export function adoptChatVideo(filePath: string): { abs: string; name: string; size: number } | null {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > REMOTE_VIDEO_FILE_MAX_BYTES) return null;
    const name = stagedName(basename(filePath));
    const abs = join(dir(), name);
    copyFileSync(filePath, abs);
    return { abs, name, size: stats.size };
  } catch {
    return null;
  }
}

/** 旧落盘目录（历史遗留）：附件曾在 `%TEMP%/mpi-clipboard`。那里属于“随时可清理”的语义，
 * 所以新附件不再往那儿放；但为了不让**已有的历史消息**凭空变成占位卡片，找不到时回这里看一眼。 */
const LEGACY_TEMP_DIR = "mpi-clipboard";

/** 按文件名解析成磁盘路径（chatatt:// 协议用）；不合法或不存在 → null。 */
export function resolveChatAttachment(name: string): string | null {
  if (!name || !NAME_RE.test(name) || name.includes("..")) return null;
  const candidates = [join(dir(false), name), join(app.getPath("temp"), LEGACY_TEMP_DIR, name)];
  for (const target of candidates) {
    if (basename(target) !== name) continue;
    try {
      if (statSync(target).isFile()) return target;
    } catch {
      /* 继续看下一个候选位置 */
    }
  }
  return null;
}

/** 启动时按总量上限清理最旧的附件（尽力而为，失败不影响启动）。 */
export function pruneChatAttachments(maxBytes = MAX_DIR_BYTES): void {
  try {
    const target = dir(false);
    if (!existsSync(target)) return;
    const entries = readdirSync(target)
      .map((name) => {
        try {
          const stats = statSync(join(target, name));
          return stats.isFile() ? { name, size: stats.size, mtime: stats.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { name: string; size: number; mtime: number } => entry !== null);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= maxBytes) return;
    for (const entry of entries.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= maxBytes) break;
      unlinkSync(join(target, entry.name));
      total -= entry.size;
    }
  } catch {
    /* 清理失败不能影响启动 */
  }
}
