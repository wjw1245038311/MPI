/**
 * 把聊天里的**视频附件**安全地递给渲染层：`chatatt://attachment/?name=<文件名>`。
 *
 * 背景（2026-09-28）：手机端发来的视频由 `stageClipboardFile` 落盘在
 * `%TEMP%/mpi-clipboard`，pi 的历史里只留一条 `<file … attach="video" path="…" />`
 * 文本引用。桌面端要「像图片一样直接看」，就得让渲染层的 `<video src>` 能取到那个文件；
 * 而渲染层不能直接用 `file://`（安全策略会挡），所以走自定义协议——与
 * todo-attachment-protocol 同一套路数：URL 只由本仓渲染层按已知元数据拼出，handler
 * 侧再校验**文件名形状 + 目录包含关系**，都不合法就 404。
 *
 * 为什么名字走 query 而不是 hostname：`standard` 协议的 hostname 会被 URL 解析器**小写化**
 * （todoatt 的文件名是纯小写 uuid 才侥幸没事），而这里的名字带用户不可控的原始大小写。
 *
 * 为什么支持 Range：视频要拖进度条。没有 206 就只能整段读完再播。
 */
import { app, protocol } from "electron";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const SCHEME = "chatatt";
/** 与 ipc.ts 的 stageClipboardFile 同一目录（app.getPath("temp")/mpi-clipboard）。 */
const CLIPBOARD_FILE_DIR = "mpi-clipboard";
/** 只为「内联播放的视频附件」设计；上限之外的请求一律拒绝（不给它当通用文件服务器用）。 */
const MAX_SERVED_BYTES = 64 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

/** 文件名白名单：`stageRemoteVideos` 产出的形状（uuid-video-<ts>-<n>.<ext>）。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;

/** 渲染层拼 URL 用的唯一入口（主机侧同名函数见 ipc.ts 的 stageRemoteVideos 注释）。 */
export function chatAttachmentUrl(name: string): string {
  return `${SCHEME}://attachment/?name=${encodeURIComponent(name)}`;
}

/**
 * 校验文件名并解析成磁盘路径；不合法或文件不存在/过大 → null。
 *
 * 双重防线：① 文件名形状白名单（挡掉 `..`／路径分隔符／盘符）；② `basename()` 回查，
 * 确保拼接后仍落在 `%TEMP%/mpi-clipboard` 里。
 */
export function resolveChatAttachment(name: string): string | null {
  if (!name || !NAME_RE.test(name) || name.includes("..")) return null;
  const dir = join(app.getPath("temp"), CLIPBOARD_FILE_DIR);
  const target = join(dir, name);
  if (basename(target) !== name) return null;
  try {
    const stats = statSync(target);
    if (!stats.isFile() || stats.size > MAX_SERVED_BYTES) return null;
  } catch {
    return null; // 临时目录可能已被系统清理——调用方按 404 显示占位卡片
  }
  return target;
}

/** 解析 `Range: bytes=…`（导出供测试）。不可满足 → null（调用方退回 200 全量）。 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // 后缀形式 bytes=-N：最后 N 字节
    const tail = Number(rawEnd);
    if (!Number.isFinite(tail) || tail <= 0) return null;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** 只读需要的区间，不把整个文件读进内存（拖动进度条会连发 Range 请求）。 */
function readSlice(path: string, start: number, end: number): Buffer {
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

export function registerChatAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

export function registerChatAttachmentProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      const url = new URL(request.url);
      const name = url.searchParams.get("name") || "";
      const target = resolveChatAttachment(name);
      if (!target) return new Response("Not found", { status: 404 });
      const size = statSync(target).size;
      const headers: Record<string, string> = {
        "Content-Type": MIME_TYPES[extname(target).toLowerCase()] || "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      const range = parseRange(request.headers.get("range"), size);
      if (range) {
        const length = range.end - range.start + 1;
        const body = request.method === "HEAD" ? "" : readSlice(target, range.start, range.end);
        return new Response(body as BodyInit, {
          status: 206,
          headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(length) },
        });
      }
      const body = request.method === "HEAD" ? "" : readFileSync(target);
      return new Response(body as BodyInit, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
    } catch (error) {
      return new Response(String((error as Error)?.message || "Invalid chat attachment request"), { status: 400 });
    }
  });
}
