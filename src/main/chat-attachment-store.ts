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
 *
 * 2026-09-28：单个上限从 3MB（当时“能内联”的上限）放宽到 REMOTE_VIDEO_MAX_BYTES——
 * 大视频不再需要内联也能看（客户端点开按需拉，见 attachment.fetch），所以「能不能存」
 * 不该再受「能不能内联」制约。
 */
import { app } from "electron";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { REMOTE_VIDEO_MAX_BYTES, VIDEO_EXT_BY_MIME } from "./remote/video-refs";

export const CHAT_ATTACHMENT_DIR = "chat-attachments";
/**
 * 目录总量上限（超出按 mtime 删最旧的）。
 *
 * 从 300MB 提到 1GB：视频不再内联后，附件区是它们唯一的家（消息里只留名字），
 * 删掉就是真的“看不了”；而 128MB 的单文件上限下，300MB 只装得下两三个视频。
 */
const MAX_DIR_BYTES = 1024 * 1024 * 1024;

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
 * 超过 REMOTE_VIDEO_MAX_BYTES 直接抛错（调用方本来就已按同一上限校验过）。
 */
export function stageChatVideoBytes(args: { name?: string; mimeType?: string; data: string }): { abs: string; name: string; size: number } {
  const bytes = Buffer.from(String(args.data || ""), "base64");
  if (!bytes.length) throw new Error("video attachment is empty");
  if (bytes.length > REMOTE_VIDEO_MAX_BYTES) throw new Error("video attachment is too large");
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
 *
 * 上限用 REMOTE_VIDEO_MAX_BYTES（128MB）而不是内联阈值：桌面端拖进来的大视频同样要能在
 * 手机/PWA 上点开看（那边走 attachment.fetch 按需拉），所以不该在这里就被挡掉。
 */
export function adoptChatVideo(filePath: string): { abs: string; name: string; size: number } | null {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > REMOTE_VIDEO_MAX_BYTES) return null;
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

/**
 * 单次按需取字节（`attachment.fetch`）最多回传的**原始**字节数。
 *
 * base64 后 ≈683KB，离 8MB 的 envelope 硬上限（protocol.ts 的 MAX_ENVELOPE_BYTES）
 * 还有十倍余量；客户端不需要知道这个值——它只按响应里的 `length` 往前推进，
 * 所以扩容只改这里，不用同步改客户端（省掉一类漂移守卫）。
 */
export const ATTACHMENT_FETCH_CHUNK_BYTES = 512 * 1024;

/** 只读需要的区间，不把整个文件读进内存（视频按需播放会连发分片请求）。 */
export function readSlice(path: string, start: number, end: number): Buffer {
  const length = end - start + 1;
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

/**
 * 按需取回附件的**一段字节**（远程客户端播视频用）。
 *
 * 名字合法性、目录包含关系都由 resolveChatAttachment 统一把关（不合法/文件不在 → null，
 * 调用方一律按 404 处理，不区分「名字非法」与「文件已被清理」——避免成为探测接口）。
 * offset 由客户端推进，服务端按 CHUNK 上限**夹紧**并回传实际长度与 eof，
 * 客户端据此循环，不必自己算分片边界。
 */
export function readAttachmentSlice(
  name: string,
  offset: number,
  maxBytes = ATTACHMENT_FETCH_CHUNK_BYTES,
): { abs: string; size: number; offset: number; eof: boolean; data: Buffer } | null {
  const abs = resolveChatAttachment(name);
  if (!abs) return null;
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    return null;
  }
  const start = Math.floor(offset);
  if (!Number.isFinite(start) || start < 0 || size <= 0 || start >= size) return null;
  const limit = Math.min(Math.max(1, Math.floor(maxBytes) || ATTACHMENT_FETCH_CHUNK_BYTES), ATTACHMENT_FETCH_CHUNK_BYTES);
  const end = Math.min(size, start + limit);
  return { abs, size, offset: start, eof: end >= size, data: readSlice(abs, start, end - 1) };
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
