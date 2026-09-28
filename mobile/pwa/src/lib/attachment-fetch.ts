/**
 * 附件按需取字节（`attachment.fetch`）—— PWA 侧。
 *
 * 背景：视频原片的 base64 不再内联进快照（否则每次快照被几 MB 的字节撑爆，见
 * `src/main/remote/video-refs.ts` 的预算逻辑与 `remoteMessages` 的回填段），改成
 * **点开才拉**。主机按片回传，
 * 客户端只需按 `offset + length` 循环，拼回来的字节逐字节等于原文件。
 *
 * 为什么不做真流式（边下边播）：那要 MSE（要求 fragmented mp4，浏览器支持参差）
 * 或让主机另开 HTTP Range 端点（要暴露端口 + 另做一套鉴权）。v1 用「拉完 → Blob →
 * objectURL」：多等一两秒，但链路单纯、进度可见、失败可重试。见交接文档的取舍表。
 *
 * 纯逻辑与浏览器能力分开：`fetchAttachmentBytes` 只做「拉字节」（node 里可测，
 * 不碰 DOM），`fetchAttachmentUrl` 才做 Blob/objectURL 与缓存。
 */
import type { RemoteAttachmentChunk } from "../../../shared/protocol";

/** 单片的请求超时：比默认 10s 宽一点（一次几百 KB，弱网下别误杀）。 */
const CHUNK_TIMEOUT_MS = 30_000;

/**
 * 分片循环的硬上限（防死循环的护栏）。
 *
 * 服务端的 `eof` 才是权威终止条件，但客户端不能只信它：一旦主机端出 bug
 * （返回空片却不置 eof、offset 不前进），循环会一直请求下去把内存吃光。
 * 512KB × 4096 片 = 2GB，远超任何现实视频，正常永远走不到。
 */
const MAX_CHUNKS = 4096;

export interface AttachmentFetchOptions {
  /** 进度回调（已收字节 / 总字节）。总字节来自主机，首片之前为 0。 */
  onProgress?: (loaded: number, total: number) => void;
  /** 取消（用户关掉预览 / 离开会话）。 */
  signal?: AbortSignal;
}

/** 只做「拉字节」的那一半：可测、不依赖 DOM。 */
export async function fetchAttachmentBytes(
  request: (name: string, offset: number) => Promise<RemoteAttachmentChunk>,
  name: string,
  options: AttachmentFetchOptions = {},
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let loaded = 0;
  let total = 0;
  for (let guard = 0; guard < MAX_CHUNKS; guard += 1) {
    if (options.signal?.aborted) throw new Error("已取消");
    const chunk = await request(name, offset);
    if (!chunk || typeof chunk.data !== "string") throw new Error("附件响应格式不对");
    if (typeof chunk.size === "number" && chunk.size > 0) total = chunk.size;
    const bytes = base64ToBytes(chunk.data);
    parts.push(bytes);
    loaded += bytes.length;
    options.onProgress?.(loaded, total);
    if (chunk.eof) return concatBytes(parts, total || loaded);
    if (!bytes.length) throw new Error("附件分片无进展（主机返回空片且未标记结束）");
    offset += bytes.length;
  }
  throw new Error("附件分片数量异常，已中止");
}

/**
 * base64 → 字节。
 *
 * 用 `atob` 而不是 `fetch(data:...)`：后者会走一遍 URL 解析与流式解码，几十 MB 下
 * 既慢又容易被 CSP 拦（media-src 那类）。这里一次分配、循环填，量级线性。
 */
export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1 && parts[0].length === total) return parts[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * 已取回的附件 objectURL 缓存（最多 2 个）。
 *
 * 为什么缓存：飞书式交互里「点开 → 关掉 → 再点开」是常见动作，不缓存就要重新拉
 * 整个文件。为什么只留 2 个：一个视频几十 MB，留多了在手机上会被系统杀掉进程。
 * 淘汰时 revoke，避免 objectURL 泄漏（它们不会随 GC 释放）。
 */
const urlCache = new Map<string, string>();
const URL_CACHE_LIMIT = 2;

/** 浏览器侧入口：拉字节 → Blob → objectURL（带缓存）。 */
export async function fetchAttachmentUrl(
  request: (name: string, offset: number) => Promise<RemoteAttachmentChunk>,
  name: string,
  mimeType: string,
  options: AttachmentFetchOptions = {},
): Promise<string> {
  const cached = urlCache.get(name);
  if (cached) {
    urlCache.delete(name);
    urlCache.set(name, cached); // LRU：命中即提到最新
    return cached;
  }
  const bytes = await fetchAttachmentBytes(request, name, options);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType || "video/mp4" }));
  urlCache.set(name, url);
  while (urlCache.size > URL_CACHE_LIMIT) {
    const oldest = urlCache.keys().next().value;
    if (oldest === undefined) break;
    const stale = urlCache.get(oldest);
    if (stale) URL.revokeObjectURL(stale);
    urlCache.delete(oldest);
  }
  return url;
}

/** 测试与调试用：清掉缓存（会 revoke）。 */
export function clearAttachmentUrlCache(): void {
  urlCache.forEach((url) => URL.revokeObjectURL(url));
  urlCache.clear();
}
