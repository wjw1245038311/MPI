/**
 * Copy chat images to the system clipboard (right-click → 复制图片).
 *
 * Pipeline: PNG data URLs are written as-is (fast path — no canvas needed, and
 * it works even if the <img> element is mid-load); everything else is
 * rasterized at natural size onto a canvas and exported as PNG, which also
 * normalizes jpeg/webp/bmp. Cross-origin images taint the canvas; toBlob then
 * throws and the caller surfaces a failure toast instead of hanging.
 */

/** Images that offer "copy image" on right-click: chat attachments, markdown imgs, lightbox preview. */
export const IMAGE_COPY_SELECTOR = "img.msg-user-img, img.md-img, img.image-lightbox-img";

export function isPngDataUrl(src: string): boolean {
  return src.startsWith("data:image/png") && src.includes(";base64,");
}

/** Decode a base64 data URL into a Blob (fetch does the decoding). */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  if (!res.ok) throw new Error(`data-url-fetch-${res.status}`);
  return res.blob();
}

/** Rasterize a loaded <img> at its natural size and export it as PNG. */
export async function imgElementToPngBlob(img: HTMLImageElement): Promise<Blob> {
  if (!img.complete) await img.decode().catch(() => undefined);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error("image-not-loaded");
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no-2d-context");
  ctx.drawImage(img, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("to-blob-failed"))), "image/png");
  });
}

/** Copy an image element to the clipboard as PNG. Throws on failure. */
export async function copyImageToClipboard(img: HTMLImageElement): Promise<void> {
  const src = img.currentSrc || img.src;
  let blob: Blob;
  if (isPngDataUrl(src)) {
    blob = await dataUrlToBlob(src);
  } else {
    blob = await imgElementToPngBlob(img);
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
