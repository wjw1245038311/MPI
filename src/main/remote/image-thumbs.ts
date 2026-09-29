/**
 * 快照里的**图片载荷决策**（P3）。
 *
 * 背景：手机发图现在是「原图走直连上传（内容寻址）+ prompt 里只带缩略图」，但**给模型的**
 * 那份必须是原图（pi 的图片输入就是 base64，不能改成路径），于是原图 base64 会写进 pi 消息、
 * 也就会跟着每一次快照下发——大图/多图会把快照重新撑起来（这正是视频当初的问题）。
 *
 * 所以快照组装时按这个顺序决定一张图该下发什么：
 *   ① 有缩略图 → 下发缩略图（几十 KB），原图由客户端按 key 按需拉；
 *   ② 没有缩略图（老消息 / 发送端抽不出缩略图）→ 原图够小就照旧内联；
 *   ③ 都不行 → **不下发**（返回 null），由调用方按预算丢弃。
 *
 * 之所以抽成纯函数：这张决策表最容易在重构里被改坏，而「坏」的表现是快照悄悄变回几 MB
 * （用户看到的是历史被挤掉、手机往上拉不动），很难现场归因。
 */

/** 单张原图仍然内联的上限（与 ipc.ts 的老行为一致：约 300KB 原始字节）。 */
export const INLINE_IMAGE_MAX_CHARS = 400_000;

export interface ImagePayloadDecision {
  /** 实际下发的 base64。 */
  data: string;
  /** 下发的是缩略图还是原图（诊断/测试用）。 */
  kind: "thumb" | "original";
}

/**
 * @param originalData pi 消息里的原图 base64（可能很大）
 * @param thumbnailData 缩略图 base64（没有 → null）
 * @param budgetLeft 本次快照剩余图片预算（字符）
 */
export function snapshotImagePayload(
  originalData: string,
  thumbnailData: string | null,
  budgetLeft: number,
): ImagePayloadDecision | null {
  if (thumbnailData && thumbnailData.length > 0) {
    return thumbnailData.length <= budgetLeft ? { data: thumbnailData, kind: "thumb" } : null;
  }
  if (originalData.length > 0 && originalData.length <= INLINE_IMAGE_MAX_CHARS && originalData.length <= budgetLeft) {
    return { data: originalData, kind: "original" };
  }
  return null;
}
