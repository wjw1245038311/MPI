/**
 * 图片字节的**客户端缓存**（2026-11-06，快照只发元数据之后的配套件）。
 *
 * 背景：`image` 块不再内联 base64，客户端按 `key`（原图）或 `thumb` 名（缩略图）
 * 去主机拉字节。滚动时同一张图会被反复挂载/卸载，不缓存就会反复拉同一份——比内联
 * 还慢，还会把中继流量打满。
 *
 * 为什么**不复用** `attachment-fetch.ts` 的 `urlCache`：那个 LRU 上限是 2，是给
 * 「点开的大视频 / 整份下载的文件」定的（一个几十 MB，留多了手机会被杀进程）。
 * 图片要的是「一屏几十张小图都在」，两者的容量诉求差了三个数量级，混用一个
 * Map 只会互相挤掉。所以这里单独一层，容量按**张数 + 估算字节**双上限。
 *
 * 与视频缓存同样用 objectURL：记得在淘汰时 revoke，否则 Blob 不会随 GC 释放。
 */

/** 一屏几十张 + 往上翻一点，给足余量；超过就从最久未用的开始丢。 */
export const IMAGE_CACHE_MAX_ENTRIES = 120;
/** 估算总字节上限（缩略图多数 60–150KB，120 张约 8–18MB；留到 24MB 容得下截图档）。 */
export const IMAGE_CACHE_MAX_BYTES = 24 * 1024 * 1024;

interface CacheEntry {
  url: string;
  bytes: number;
}

const cache = new Map<string, CacheEntry>();
let totalBytes = 0;
/** 同一张图并发请求时复用同一个 Promise（避免一屏同时挂载时拉两遍）。 */
const inflight = new Map<string, Promise<string>>();

export interface ImageLoadOptions {
  signal?: AbortSignal;
  /** 兼容测试：注入字节拉取函数（生产走 attachment.fetch，见 ThreadView）。 */
  request: (name: string) => Promise<Uint8Array>;
}

/** 命中缓存时直接返回；调用方无需关心 LRU（命中会自动提到最新）。 */
export function peekImageUrl(name: string): string | null {
  const entry = cache.get(name);
  if (!entry) return null;
  cache.delete(name);
  cache.set(name, entry);
  return entry.url;
}

/**
 * 拉取并缓存一张图，返回可直接给 `<img src>` 的 objectURL。
 *
 * @param name   主机侧附件名（缩略图名或内容 key）
 * @param mimeType 用于构造 Blob（缩略图一律 image/jpeg；原图用块里的 mimeType）
 */
export async function loadImageUrl(name: string, mimeType: string, options: ImageLoadOptions): Promise<string> {
  const cached = peekImageUrl(name);
  if (cached) return cached;
  const existing = inflight.get(name);
  if (existing) return existing;

  const task = (async () => {
    if (options.signal?.aborted) throw new Error("已取消");
    const bytes = await options.request(name);
    if (!bytes.length) throw new Error("图片字节为空");
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType || "image/jpeg" }));
    put(name, url, bytes.length);
    return url;
  })();
  inflight.set(name, task);
  try {
    return await task;
  } finally {
    inflight.delete(name);
  }
}

function put(name: string, url: string, bytes: number): void {
  const previous = cache.get(name);
  if (previous) {
    totalBytes -= previous.bytes;
    // 同名重新拉（例如缩略图被替换）：旧 objectURL 必须 revoke。
    if (previous.url !== url) URL.revokeObjectURL(previous.url);
    cache.delete(name);
  }
  cache.set(name, { url, bytes });
  totalBytes += bytes;
  while (cache.size > IMAGE_CACHE_MAX_ENTRIES || totalBytes > IMAGE_CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    if (oldest === name) break; // 刚放进去的这张不淘汰（单张就超预算时也保留它）
    const stale = cache.get(oldest);
    if (stale) {
      totalBytes -= stale.bytes;
      URL.revokeObjectURL(stale.url);
    }
    cache.delete(oldest);
  }
}

/** 测试与调试用：清空缓存（会 revoke 所有 objectURL）。 */
export function clearImageCache(): void {
  cache.forEach((entry) => URL.revokeObjectURL(entry.url));
  cache.clear();
  inflight.clear();
  totalBytes = 0;
}

/** 诊断用：当前缓存张数与估算字节。 */
export function imageCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: totalBytes };
}
