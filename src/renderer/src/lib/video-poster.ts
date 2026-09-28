/**
 * 桌面端：给视频附件抽一张**首帧封面**（发送时随附件一起交给主进程）。
 *
 * 为什么由发送端抽而不是主机抽：主机没有视频解码器（要内嵌 ffmpeg，几十 MB × 多平台），
 * 而渲染层有 `<video>` + `<canvas>`，本来就什么都能解；手机端同理（MediaMetadataRetriever）。
 *
 * 为什么需要封面：快照不再下发视频本体（见 remote/video-refs.ts），气泡里的画面
 * 就只剩这张封面；抽不出来时客户端退化成深色卡片 + ▶，照样可点开按需拉。
 *
 * 尺寸与体积：最长边 ≤ POSTER_MAX_EDGE，JPEG 质量循环降到 ≤ POSTER_MAX_BYTES——
 * 封面要**跟着每一次快照**下发，不能让它变成新的“大字节”。
 */

/** 最长边（px）。640 足够手机上的气泡卡片（卡片宽度约 300dp）。 */
const POSTER_MAX_EDGE = 640;
/** 原始字节上限，与主机侧 remote/video-refs.ts 的 VIDEO_POSTER_MAX_BYTES 一致（有测试守卫）。 */
const POSTER_MAX_BYTES = 160_000;
const POSTER_MIN_QUALITY = 0.5;

export interface VideoPoster {
  data: string;
  mimeType: string;
}

/** 抽帧超时（损坏文件可能永远不触发 loadeddata / seeked）。 */
const POSTER_TIMEOUT_MS = 8_000;

function base64FromCanvas(canvas: HTMLCanvasElement, quality: number): string {
  // toDataURL 返回 "data:image/jpeg;base64,xxx"，主机要的是裸 base64。
  return canvas.toDataURL("image/jpeg", quality).split(",", 2)[1] || "";
}

/** 估算 base64 的原始字节数（不去真正解码）。 */
const rawBytesOf = (base64: string): number => Math.floor((base64.length * 3) / 4);

/**
 * 从一个视频 File 抽首帧。失败（不是视频 / 解不出来 / 超时）→ null，调用方照常发送。
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
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onloadeddata = done;
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("无法解码这个视频"));
      };
    });

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    // 有些编码在 t=0 只给黑帧；seek 到 0.1s 再抓（与手机端 `#t=0.1` 促帧同理）。
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

    // 质量循环：目标是不超过 POSTER_MAX_BYTES（封面要进每次快照，不能太胖）。
    let quality = 0.72;
    let data = base64FromCanvas(canvas, quality);
    while (rawBytesOf(data) > POSTER_MAX_BYTES && quality > POSTER_MIN_QUALITY) {
      quality = Math.round((quality - 0.1) * 100) / 100;
      data = base64FromCanvas(canvas, quality);
    }
    if (!data) return null;
    return { data, mimeType: "image/jpeg" };
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** 按扩展名/MIME 判断是不是视频（渲染层侧；主机侧另有 isVideoFile）。 */
export function looksLikeVideo(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  return /\.(mp4|m4v|webm|mov|mkv|avi)$/i.test(file.name || "");
}
