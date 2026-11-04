/**
 * agent 递交的**图片**附件 → 缩略图（手机端要能直接在气泡里看到，而不是文件卡）。
 *
 * 背景（2026-11-04 用户要求）：`mpi_attach_file` 传图片时走 `file` 块，手机上只有一张
 * 「点开下载」的卡；而用户自己发的图片是**内联显示**的。差距全在块类型：`image` 块自带
 * base64 缩略图（快照直接下发），原图由客户端按 key 按需拉。
 *
 * 为什么缩略图要落盘而不是每次现算：快照会反复生成（滚历史、重订阅、补拉），每次都
 * 解码一张几 MB 的原图会把主进程拖住；`<key>.thumb.jpg` 与用户发图用的是同一套命名
 * （`thumbNameFor`），客户端/GC 不需要区分来源。
 *
 * 尺寸取 1280 宽、JPEG 78：手机上双击放大也够看，base64 后通常 60–150KB，能塞进快照
 * 预算（`VIDEO_POSTER_MAX_BYTES` 是硬上限，超了 storeThumbnail 会拒绝）。
 */
import { nativeImage } from "electron";
import { storeThumbnail } from "./chat-attachment-store";

/** 缩略图候选（宽, JPEG 质量）：从清晰到省字节，第一个能被 `storeThumbnail` 接受的胜出。
 *
 * 为什么要试几轮：`storeThumbnail` 有 160KB 硬上限（与视频封面同一档），而截图类原图细节多，
 * 1280/q78 很容易超——超了就只能退回文件卡，用户看到的是「图片又要下载」。 */
const THUMB_ATTEMPTS: Array<{ width: number; quality: number }> = [
  { width: 1280, quality: 78 },
  { width: 1024, quality: 70 },
  { width: 820, quality: 62 },
];

/**
 * 给对象库里的图片生成/复用缩略图，返回缩略图名（失败 → null，调用方回落到文件卡）。
 */
export function ensureAttachImageThumb(name: string, sourcePath: string): string | null {
  try {
    const image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) return null;
    const { width } = image.getSize();
    for (const attempt of THUMB_ATTEMPTS) {
      const target = width && width < attempt.width ? image : image.resize({ width: attempt.width, quality: "good" });
      const jpeg = target.toJPEG(attempt.quality);
      if (!jpeg.length) continue;
      const thumb = storeThumbnail(name, { data: jpeg.toString("base64"), mimeType: "image/jpeg" });
      if (thumb) return thumb;
    }
    return null;
  } catch {
    return null;
  }
}
