/**
 * Image attachment pipeline for the composer (T2).
 *
 * Phone photos are 3–15 MB; the remote protocol caps each image at 400k base64
 * chars and the whole snapshot shares a 400k budget, so we downscale + re-encode
 * client-side before sending: max edge ≤ MAX_EDGE px, JPEG quality looped down
 * until the RAW bytes fit under MAX_RAW_BYTES (base64 inflates by ~33%).
 */

export const MAX_EDGE = 1280;
/** Raw byte budget → base64 ≈ 373k chars < host per-image cap of 400k. */
export const MAX_RAW_BYTES = 280 * 1024;
const MIN_QUALITY = 0.5;

/**
 * Pure quality-loop step (unit-testable without DOM): given the estimated raw
 * byte size at the current quality, decide whether we're done or which lower
 * quality to try next.
 */
export function nextQuality(rawBytes: number, quality: number): { done: boolean; quality: number } {
  if (rawBytes <= MAX_RAW_BYTES || quality <= MIN_QUALITY) return { done: true, quality };
  return { done: false, quality: Math.round((quality - 0.1) * 100) / 100 };
}

export interface CompressedImage {
  /** Base64 payload (no data: prefix) — matches RemoteImageInput.data. */
  data: string;
  mimeType: "image/jpeg";
}

function loadImage(file: File): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法解码这张图片（格式不受支持？）"));
    };
    img.src = url;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): string {
  return canvas.toDataURL("image/jpeg", quality);
}

/** Downscale + JPEG-compress a picked image file for prompt attachment. */
export async function compressImageFile(file: File): Promise<CompressedImage> {
  const loaded = await loadImage(file);
  const img = loaded.img;
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 不可用");
    // White background: JPEG has no alpha and screenshots often have it.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    let quality = 0.8;
    for (;;) {
      const dataUrl = canvasToJpeg(canvas, quality);
      const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      // base64 length ≈ raw bytes * 4/3 → derive raw size without decoding.
      const step = nextQuality(Math.floor(b64.length * 0.75), quality);
      if (step.done) return { data: b64, mimeType: "image/jpeg" };
      quality = step.quality;
    }
  } finally {
    URL.revokeObjectURL(loaded.url);
  }
}
