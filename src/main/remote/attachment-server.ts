/**
 * **附件直连服务**（P1）：把「字节搬运」从协议通道里摘出来，改成 HTTP 直连。
 *
 * 为什么需要它：原来上行是「整帧 base64 内联在 JSON envelope 里」，于是
 *   · 单文件被 8MB 的内层 envelope 上限卡到 ~6MB（`thread.prompt` 那一帧）；
 *   · 下行只能按片走中继，拉完才播、不能拖进度条。
 * 直连之后：上行 `PUT` 分片（可到磁盘容量）、下行 `GET` + Range（真流式、可 seek）。
 *
 * 暴露方式（见 scripts/setup-attachment-serve.sh）：
 *   服务只绑 **127.0.0.1**，再由 `tailscale serve --tcp` 转发到 tailnet。
 *   这样局域网、公网都碰不到它，且不需要证书（Tailscale 自己就是 WireGuard 加密）。
 *   URL 形如 `http://workstation.tail38d5a.ts.net:8899/att/<token>`。
 *
 * 授权：只有一个凭证——**能力令牌**（见 attachment-tokens.ts）。令牌由主机通过既有 E2E
 * 通道签发，绑定 (会话, 附件, 设备, 方向, 时限)；服务端每个请求都验它，不通过一律 403/404。
 * 名字合法性、目录包含关系仍然由 chat-attachment-store 的既有校验兜底。
 *
 * 不做的事：不在这里做会话作用域判断（那是 ipc.ts 的 attachmentNameAllowed，签发令牌时
 * 已经判过一次）；不做 TLS（Tailscale 负责）；不做用户认证（令牌即凭证）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { parseRange } from "../chat-attachment-protocol";
import {
  abandonUpload,
  completeUploadedVideo,
  readSlice,
  reserveVideoName,
  resolveChatAttachment,
  storeVideoPoster,
  writeUploadChunk,
} from "./../chat-attachment-store";
import type { AttachmentToken, AttachmentTokenStore } from "./attachment-tokens";
import { parseUploadOffset } from "./attachment-tokens";
import {
  ATTACHMENT_ENC_HEADER,
  ATTACHMENT_ENC_OVERHEAD,
  attachmentAad,
  decryptAttachmentBody,
  deriveAttachmentKey,
  encryptAttachmentBody,
  wantsEncryption,
} from "./attachment-crypto";

/** 单个上传的最大原始字节（与 REMOTE_VIDEO_MAX_BYTES 一致：128MB）。 */
export const ATTACHMENT_UPLOAD_MAX_BYTES = 128 * 1024 * 1024;
/** 单次 PUT 分片的字节上限（客户端按这个粒度切；太大则一次弱网重传代价高）。 */
export const ATTACHMENT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/** 封面的 base64 上限（与 service.ts 的 MAX_REMOTE_POSTER_DATA 同一口径）。 */
const POSTER_BASE64_MAX = 240_000;

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface AttachmentServerOptions {
  tokens: AttachmentTokenStore;
  /** 监听地址（默认只绑本机，由 tailscale serve 或反向代理转发到外网）。 */
  host?: string;
  port?: number;
  /**
   * 可选：用 TLS 直起（不经 tailscale serve / 反向代理）。
   *
   * 用途：把附件服务经**公网**暴露（例如反向 SSH 隧道绑到 ECS 的公网端口）时，
   * TLS 必须由我们自己终结——客户端（安卓 OkHttp、PWA）都要求受信证书。
   * 证书通常是腾讯云免费 DV 或 Let's Encrypt 签发的单个域名证书。
   */
  tls?: { certFile: string; keyFile: string };
  /**
   * 取某个设备的 E2E 会话密钥（用于附件载荷的**应用层加密**，见 attachment-crypto.ts）。
   *
   * 返回 null = 该设备没有会话密钥（旧客户端/未建立 E2E）→ 加密请求一律拒（不能静默降级成明文，
   * 否则客户端以为内容被加密了）。不提供本选项 = 本主机不支持加密载荷（只服务明文请求）。
   */
  keyFor?: (deviceId: string, token: string) => Buffer | null;
  /** 诊断日志（主机的 appendDiagLog；测试里可传空函数）。 */
  log?: (line: string) => void;
  /** 字节收齐时回调：调用方据此把附件登记到作用域允许表（ipc.ts 用）。 */
  onUploadComplete?: (info: { name: string; size: number; threadId: string; deviceId: string }) => void;
}

interface ResolvedRequest {
  token: AttachmentToken;
  /** URL 里的 token 原文（用于回报与撤销）。 */
  raw: string;
}

/** CORS：PWA 与 ECS 上的静态站不同源，浏览器必须放行，否则直连在网页端永远失败。 */
function baseHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Range, Content-Type, X-MPI-Offset",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, X-MPI-Received",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...baseHeaders(), "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) });
  res.end(payload);
}

/** 读请求体（带上限；超限直接断，不把内存吃光）。 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * 起服务。返回的 Server 由调用方负责 close（主机退出/重建服务时）。
 * 端口给 0 时由系统分配（测试用），实际端口从 `server.address()` 读。
 */
export function createAttachmentServer(options: AttachmentServerOptions): Server {
  const log = options.log ?? (() => {});
  const host = options.host || "127.0.0.1";
  const port = options.port ?? 8899;

  const resolveToken = (req: IncomingMessage, url: URL): ResolvedRequest | null => {
    const raw = decodeURIComponent(url.pathname.replace(/^\/att\/?/, ""));
    if (!raw) return null;
    const token = options.tokens.get(raw);
    return token ? { token, raw } : null;
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "OPTIONS") {
        res.writeHead(204, baseHeaders());
        res.end();
        return;
      }
      if (!url.pathname.startsWith("/att/")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const resolved = resolveToken(req, url);
      if (!resolved) {
        // 令牌无效/过期：一律 403，不回显原因（避免变成探测工具）。
        log(`attachment-http reject path=${url.pathname.slice(0, 24)} code=bad-token`);
        sendJson(res, 403, { error: "invalid or expired token" });
        return;
      }
      const { token } = resolved;

      // ---- 下行：GET / HEAD（支持 Range，播放器靠它 seek）----
      if (req.method === "GET" || req.method === "HEAD") {
        if (token.mode !== "read") {
          sendJson(res, 403, { error: "write token" });
          return;
        }
        const abs = resolveChatAttachment(token.name);
        if (!abs) {
          log(`attachment-http 404 name=${token.name.slice(0, 48)}`);
          sendJson(res, 404, { error: "attachment is no longer available" });
          return;
        }
        const size = statSync(abs).size;
        const headers: Record<string, string> = {
          ...baseHeaders(),
          "Content-Type": MIME_TYPES[extname(abs).toLowerCase()] || "application/octet-stream",
          "Accept-Ranges": "bytes",
        };
        // 应用层加密的下行（客户端自愿开启）：按 per-device 会话密钥加密本次响应的字节，
        // AAD 绑住 (方向, 附件名, 起始偏移, 明文长度) → 中间人改不了 Range 也无法重排。
        const encRequested = wantsEncryption(req.headers[ATTACHMENT_ENC_HEADER]);
        const encSessionKey = encRequested ? options.keyFor?.(token.deviceId, resolved.raw) : undefined;
        if (encRequested && !encSessionKey) {
          log(`attachment-http enc reject name=${token.name.slice(0, 36)} reason=no-session-key`);
          sendJson(res, 400, { error: "encrypted payload is not supported for this device" });
          return;
        }
        const encryptSlice = (plaintext: Buffer, start: number): Buffer => {
          headers["X-MPI-Enc"] = "v1";
          headers["X-MPI-Len"] = String(plaintext.length);
          return encryptAttachmentBody(
            deriveAttachmentKey(encSessionKey as Buffer, resolved.raw, "down", token.name),
            plaintext,
            attachmentAad("down", token.name, start, plaintext.length),
          );
        };
        const range = parseRange(req.headers.range ?? null, size);        token.hits += 1;
        // 取证：**直连下行到底有没有被用上**。一次播放有几十条 Range 请求，全记会刷爆日志，
        // 只记这条令牌的第一次命中——排查时「有这行 = 走了直连 / 没有 = 客户端回落了中继」。
        const firstHit = token.hits === 1;
        if (firstHit) {
          log(`attachment-http GET name=${token.name.slice(0, 48)} size=${size} range=${req.headers.range ?? "-"}`);
        }
        const startedAt = Date.now();
        if (firstHit) {
          // 首次命中往往是播放器的「整段探测」（不带 Range），它直接量出这条链路的**下行**速率；
          // 有了这一行，就不必靠“感觉快慢”或推测。
          const sent = range ? range.end - range.start + 1 : size;
          // 加密时实际发出的字节 = 明文 + nonce/tag 开销；两栏都记，否则「bytes」会被误读成明文长度。
          const payloadBytes = encSessionKey ? sent + ATTACHMENT_ENC_OVERHEAD : sent;
          res.on("finish", () => {
            const ms = Date.now() - startedAt;
            const mbs = ms > 0 ? (payloadBytes / 1048576) / (ms / 1000) : 0;
            log(
              `attachment-http GET done name=${token.name.slice(0, 48)} bytes=${payloadBytes} enc=${encSessionKey ? 1 : 0} plain=${sent} ms=${ms} mbs=${mbs.toFixed(2)}`,
            );
          });
        }
        if (range) {
          const slice = req.method === "HEAD" ? Buffer.alloc(0) : readSlice(abs, range.start, range.end);
          const payload = encSessionKey ? encryptSlice(slice, range.start) : slice;
          res.writeHead(206, { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(payload.length) });
          res.end(payload as unknown as Buffer);
          return;
        }
        const full = req.method === "HEAD" ? Buffer.alloc(0) : readFileSync(abs);
        const payload = encSessionKey ? encryptSlice(full, 0) : full;
        res.writeHead(200, { ...headers, "Content-Length": String(payload.length) });
        res.end(payload as unknown as Buffer);
        return;
      }

      // ---- 上行：PUT 分片 ----
      if (req.method === "PUT") {
        const reqStartedAt = Date.now();
        if (token.mode !== "write") {
          sendJson(res, 403, { error: "read token" });
          return;
        }
        const declared = parseUploadOffset(req.headers["content-range"] as string | undefined ?? null, (req.headers["x-mpi-offset"] as string | undefined) ?? null);
        if (!declared) {
          log(`attachment-http PUT bad-range name=${token.name.slice(0, 36)}`);
          sendJson(res, 400, { error: "Content-Range or X-MPI-Offset is required" });
          return;
        }
        const body = await readBody(req, ATTACHMENT_UPLOAD_CHUNK_BYTES + 64 * 1024 + ATTACHMENT_ENC_OVERHEAD);
        if (!body) {
          sendJson(res, 413, { error: "chunk is too large" });
          return;
        }
        // 取证：每片耗时（含收包）——分辨「网慢」与「服务端写盘慢」就靠这一行。
        const chunkMs = Date.now() - reqStartedAt;
        // 应用层加密载荷：按令牌+方向+附件名派生密钥，AAD 绑住片位置（防重排/改标）。
        // 解不开一律 400——不静默当作明文写盘（那会把垃圾写进附件区）。
        let plain = body;
        if (wantsEncryption(req.headers[ATTACHMENT_ENC_HEADER])) {
          const sessionKey = options.keyFor?.(token.deviceId, resolved.raw);
          if (!sessionKey) {
            log(`attachment-http enc reject name=${token.name.slice(0, 36)} reason=no-session-key`);
            sendJson(res, 400, { error: "encrypted payload is not supported for this device" });
            return;
          }
          if (body.length < ATTACHMENT_ENC_OVERHEAD) {
            sendJson(res, 400, { error: "encrypted chunk is too short" });
            return;
          }
          try {
            const aad = attachmentAad("up", token.name, declared.offset, body.length - ATTACHMENT_ENC_OVERHEAD);
            plain = decryptAttachmentBody(deriveAttachmentKey(sessionKey, resolved.raw, "up", token.name), body, aad);
          } catch (error) {
            log(`attachment-http enc decrypt failed name=${token.name.slice(0, 36)} err=${String((error as Error)?.message).slice(0, 40)}`);
            sendJson(res, 400, { error: "could not decrypt chunk" });
            return;
          }
        }
        const total = declared.total ?? token.size ?? null;
        if (token.size && declared.offset + plain.length > token.size) {
          sendJson(res, 400, { error: "chunk exceeds declared size" });
          return;
        }
        if (total !== null && declared.offset + plain.length > total) {
          sendJson(res, 400, { error: "chunk exceeds total size" });
          return;
        }
        try {
          token.received = Math.max(token.received, writeUploadChunk(token.name, declared.offset, plain));
        } catch (error) {
          log(`attachment-http PUT failed name=${token.name.slice(0, 36)} err=${String((error as Error)?.message).slice(0, 60)}`);
          sendJson(res, 500, { error: "could not store chunk" });
          return;
        }
        const done = total !== null ? token.received >= total : false;
        if (done) {
          const completed = completeUploadedVideo(token.name);
          if (!completed) {
            log(`attachment-http finalize failed name=${token.name.slice(0, 36)}`);
            sendJson(res, 500, { error: "could not finalize upload" });
            return;
          }
          log(`attachment-http upload done name=${token.name.slice(0, 36)} size=${completed.size}`);
          options.onUploadComplete?.({ name: token.name, size: completed.size, threadId: token.threadId, deviceId: token.deviceId });
        }
        log(
          `attachment-http PUT name=${token.name.slice(0, 36)} off=${declared.offset} len=${plain.length} ms=${chunkMs} cum=${token.received}/${total ?? "?"}`,
        );
        sendJson(res, 200, { name: token.name, received: token.received, size: total, done });
        return;
      }

      // ---- 上行：POST 封面（数据收齐之后单独送，避免与视频分片抢带宽/顺序）----
      if (req.method === "POST") {
        if (token.mode !== "write") {
          sendJson(res, 403, { error: "read token" });
          return;
        }
        const body = await readBody(req, POSTER_BASE64_MAX + 4096);
        if (!body) {
          sendJson(res, 413, { error: "poster is too large" });
          return;
        }
        let parsed: { poster?: string; posterMimeType?: string };
        try {
          parsed = JSON.parse(body.toString("utf8")) as { poster?: string; posterMimeType?: string };
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (!parsed.poster || typeof parsed.poster !== "string" || parsed.poster.length > POSTER_BASE64_MAX) {
          sendJson(res, 400, { error: "poster is required" });
          return;
        }
        const posterName = storeVideoPoster(token.name, { data: parsed.poster, mimeType: parsed.posterMimeType });
        sendJson(res, 200, { name: token.name, posterName: posterName ?? null });
        return;
      }

      sendJson(res, 405, { error: "method not allowed" });
    })().catch((error) => {
      log(`attachment-http error ${String((error as Error)?.message).slice(0, 80)}`);
      try {
        sendJson(res, 500, { error: "internal error" });
      } catch {
        /* 响应可能已经开始写了 */
      }
    });
  };

  // TLS 是可选的：走 tailscale serve / 内网反向代理时保持明文 http（由那层终结 TLS），
  // 经公网隧道暴露时才需要自己终结（证书文件不存在就让 readFileSync 抛，不静默降级成明文）。
  const server = options.tls
    ? createHttpsServer(
        { cert: readFileSync(options.tls.certFile), key: readFileSync(options.tls.keyFile) },
        handle,
      )
    : createServer(handle);

  server.on("clientError", (_err, socket) => socket.destroy());
  server.listen(port, host, () => {
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    log(`attachment-http listening ${options.tls ? "https" : "http"}://${host}:${actual}`);
  });
  return server;
}

/** 供签发令牌时预分配名字（ipc.ts 用；导出以免两处各写一遍命名规则）。 */
export function reserveUploadTarget(originalName?: string, mimeType?: string): string {
  return reserveVideoName(originalName, mimeType);
}

/** 客户端取消上传时清理临时文件（ipc.ts 在令牌失效/会话关闭时调用）。 */
export function discardUpload(name: string): void {
  abandonUpload(name);
}
