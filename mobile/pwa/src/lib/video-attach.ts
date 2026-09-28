/**
 * PWA：给视频附件抽一张**首帧封面**（发送时随视频一起上传）。
 *
 * 为什么由发送端抽而不是主机抽：主机没有视频解码器（要内嵌 ffmpeg，几十 MB × 多平台），
 * 而浏览器有 `<video>` + `<canvas>`，本来就什么都能解；桌面端与安卓同理
 * （`src/renderer/src/lib/video-poster.ts` / MediaMetadataRetriever）。
 *
 * 为什么需要封面：快照不再下发视频本体（见主机侧 remote/video-refs.ts），
 * 气泡里的画面就只剩这张封面；抽不出来时客户端退化成深色卡片 + ▶，照样可点开按需拉。
 *
 * 体积：最长边 ≤ POSTER_MAX_EDGE、JPEG 质量循环降到 ≤ POSTER_MAX_BYTES——
 * 封面要跟着**每一次快照**下发，不能让它变成新的“大字节”。
 * 三个常量与主机侧守卫一致（scripts/test-remote-video.mjs）。
 */

/** 最长边（px）。手机上的气泡卡片约 300dp 宽，640 已经足够清晰。 */
export const POSTER_MAX_EDGE = 640;
/** 原始字节上限，与主机侧 VIDEO_POSTER_MAX_BYTES 一致。 */
export const POSTER_MAX_BYTES = 160_000;
const POSTER_MIN_QUALITY = 0.5;
/** 抽帧超时：损坏文件可能永远不触发 loadeddata / seeked。 */
const POSTER_TIMEOUT_MS = 8_000;

export interface VideoPoster {
  data: string;
  mimeType: string;
}

const rawBytesOf = (base64: string): number => Math.floor((base64.length * 3) / 4);

function canvasBase64(canvas: HTMLCanvasElement, quality: number): string {
  return canvas.toDataURL("image/jpeg", quality).split(",", 2)[1] || "";
}

/**
 * 从一个视频 File 抽首帧。失败（解不出来 / 超时）→ null，调用方照常上传视频。
 *
 * 与桌面端同一套做法：等 `loadeddata` → seek 到 0.1s（有些编码在 t=0 给黑帧）→ canvas 抓帧
 * → 质量循环压到字节上限内。
 */
export async function extractVideoPoster(file: File): Promise<VideoPoster | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("抽帧超时")), POSTER_TIMEOUT_MS);
      video.onloadeddata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("无法解码这个视频"));
      };
    });

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    if (video.duration > 0.2 && video.currentTime < 0.1) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 1_500);
        video.onseeked = () => {
          window.clearTimeout(timer);
          resolve();
        };
        video.currentTime = 0.1;
      });
    }

    const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    let quality = 0.72;
    let data = canvasBase64(canvas, quality);
    while (rawBytesOf(data) > POSTER_MAX_BYTES && quality > POSTER_MIN_QUALITY) {
      quality = Math.round((quality - 0.1) * 100) / 100;
      data = canvasBase64(canvas, quality);
    }
    return data ? { data, mimeType: "image/jpeg" } : null;
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
