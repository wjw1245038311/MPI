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
import { protocol } from "electron";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { appendDiagLog } from "./diag-log";
import { resolveChatAttachment } from "./chat-attachment-store";

const SCHEME = "chatatt";
// 附件的落盘目录、文件名白名单与合法性校验都在 chat-attachment-store.ts——这里只管协议。

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

/** 渲染层拼 URL 用的唯一入口（落盘侧见 chat-attachment-store.ts）。 */
export function chatAttachmentUrl(name: string): string {
  return `${SCHEME}://attachment/?name=${encodeURIComponent(name)}`;
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
      if (!target) {
        // 取证：404 是「播放器转圈 / 显示占位卡片」最常见的原因（附件被清理、名字对不上），
        // 而协议请求本身不进任何日志——没这行就只能猜。
        appendDiagLog(`chatatt 404 name=${name.slice(0, 60)}`);
        return new Response("Not found", { status: 404 });
      }
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
