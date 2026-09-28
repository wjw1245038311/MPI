/**
 * 附件**直连**（P1）——PWA 侧：上行 PUT 分片、下行拿可直接播放的 URL。
 *
 * 为什么要有这条路：原来上行把整个文件 base64 内联进 `thread.prompt` 那一帧，于是
 *   · 单文件被 8MB 内层 envelope 上限卡到 ~6MB（再加封面额度更窄）；
 *   · 下行只能按片走中继，拉完才能播、不能拖进度条。
 * 直连之后：上行按 4MB 分片 PUT（上限 128MB），下行拿 URL 直接喂给 `<video>`（原生 Range、可 seek）。
 *
 * **回落是一等公民**：直连依赖 Tailscale 可达 + 主机开了服务 + 浏览器没拦混合内容。
 * 任何一步不成立都要能退回老路（内联 / 中继分片），所以这里所有失败都通过返回值表达，
 * 不抛给 UI——调用方按 null / false 走回落分支。
 */
import type { ThreadActions } from "./thread-actions";

/** 单次 PUT 的分片大小。与主机侧 ATTACHMENT_UPLOAD_CHUNK_BYTES 对齐（4MB）。 */
export const DIRECT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export interface DirectTarget {
  url: string;
  token: string;
  /** 写：主机预分配的附件名（消息里只带它）；读：附件名。 */
  name: string;
  expiresAt: number;
}

export interface DirectUploadResult {
  storedName: string;
  /** 封面是否已随上传送达主机（失败也不影响视频本身）。 */
  posterStored: boolean;
}

/**
 * 申请直连 URL。直连不可用（主机回 DIRECT_UNAVAILABLE / 网络不可达）→ null。
 * 其余错误（作用域不符等）也按 null 处理：调用方总能走回落，不该为此弹错误。
 */
export async function requestDirectTarget(
  actions: ThreadActions,
  input: { mode: "read" | "write"; name?: string; originalName?: string; mimeType?: string; size?: number },
): Promise<DirectTarget | null> {
  try {
    return await actions.requestAttachmentUrl(input);
  } catch {
    return null;
  }
}

/** 单次分片请求超时（4MB 在弱网下可能慢；比默认 10s 宽）。 */
const CHUNK_TIMEOUT_MS = 60_000;

/**
 * 把字节分片 PUT 到主机。
 *
 * 为什么不用一次 PUT 整个文件：主机侧按 `Content-Range` 定位写、按 `total` 判收齐；
 * 分片能拿到**真实进度**（用户看得到）也能只重传失败的那一片（弱网下差别很大）。
 */
async function putChunks(
  url: string,
  bytes: Uint8Array,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const total = bytes.byteLength;
  for (let offset = 0; offset < total; offset += DIRECT_UPLOAD_CHUNK_BYTES) {
    if (signal?.aborted) return false;
    const end = Math.min(offset + DIRECT_UPLOAD_CHUNK_BYTES, total);
    const slice = bytes.subarray(offset, end);
    const controller = new AbortController();
    // globalThis 而不是 window：这段逻辑要能在 node 下单测（浏览器里两者同一个东西）。
    const timer = globalThis.setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
    const abortRelay = () => controller.abort();
    signal?.addEventListener("abort", abortRelay, { once: true });
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}`, "Content-Type": "application/octet-stream" },
        // Blob 而不是裸 Uint8Array：TS 的 BodyInit 不收 Uint8Array<ArrayBufferLike>
        // （SharedArrayBuffer 分支），而且 Blob 不会把整段内存再拷一份。
        body: new Blob([slice as BlobPart]),
        signal: controller.signal,
      });
      if (!response.ok) return false;
      onProgress(end, total);
    } catch {
      return false;
    } finally {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abortRelay);
    }
  }
  return true;
}

/** 送封面（数据收齐之后单独一次 POST；失败只是没封面，不算上传失败）。 */
async function postPoster(url: string, poster: string, posterMimeType: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poster, posterMimeType }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { posterName?: string | null };
    return !!body?.posterName;
  } catch {
    return false;
  }
}

/**
 * 上传一个视频（直连）。成功 → `storedName`（消息里只带它，零字节）；
 * 失败 → null，调用方走内联回落。
 */
export async function uploadVideoDirect(
  actions: ThreadActions,
  input: { file: File; bytes: Uint8Array; mimeType: string; poster?: { data: string; mimeType: string } | null },
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<DirectUploadResult | null> {
  const target = await requestDirectTarget(actions, {
    mode: "write",
    originalName: input.file.name || "video.mp4",
    mimeType: input.mimeType,
    size: input.bytes.byteLength,
  });
  if (!target) return null;
  if (!(await putChunks(target.url, input.bytes, onProgress, signal))) return null;
  const posterStored = input.poster ? await postPoster(target.url, input.poster.data, input.poster.mimeType) : false;
  return { storedName: target.name, posterStored };
}

/** 拿一个可直接喂给 `<video src=…>` 的读 URL（原生 Range / 可 seek）。不可用 → null。 */
export async function requestDirectPlaybackUrl(
  actions: ThreadActions,
  name: string,
  mimeType: string,
): Promise<string | null> {
  const target = await requestDirectTarget(actions, { mode: "read", name, mimeType });
  return target?.url || null;
}
