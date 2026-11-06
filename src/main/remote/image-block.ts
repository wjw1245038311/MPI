/**
 * image 块的**元数据形态**（2026-11-06，快照不再内联缩略图 base64）。
 *
 * 背景：`image` 是最后一个还在快照里搬字节的块类型（`file` / `video` / `audio` 早就
 * 「只发名字 + `omitted:true`，点开按需拉」）。图片数量一多，240KB 的图片预算只够
 * 1–3 张，超出的块直接 `return null` —— 手机上连图带 key 一起消失，点不开也拉不到。
 *
 * 新形态把「去哪拉」写清楚，字节交给客户端按需取：
 *
 * ```
 * { type:"image", key:"<sha256>", mimeType, omitted:true,
 *   thumb:"<key>.thumb.jpg", lqip:"<base64>", bytes, width, height }
 * ```
 *
 * 为什么抽成纯函数：这张决策表最容易在重构里被改回「顺手内联缩略图」，而回退的表现是
 * 快照体积悄悄涨回几 MB（用户看到的是历史被挤掉、手机往上拉不动），很难现场归因。
 * 与 `image-thumbs.ts` 的 `snapshotImagePayload` 同一定位：可单测、一眼能看懂。
 */
import type { RemoteMessage } from "./protocol";

export type RemoteBlock = NonNullable<RemoteMessage["blocks"]>[number];

/** 缩略图/原图都只接受这几种 MIME（其余按 JPEG 处理，避免客户端拿到不认识的类型）。 */
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp|gif|avif|heic|heif)$/i;

export interface RemoteImageMetaInput {
  /** 内容寻址 key（sha256 小写 hex）。没有 key 时**不能**走这条路径（无法按需拉）。 */
  key: string;
  /** 原图 MIME。 */
  mimeType?: string;
  /** 可读名（截图/图片常为空）。 */
  label?: string;
  /** 已存在的缩略图名（优先用调用方探测到的那个，可能是历史的 `<key>.poster.jpg`）。 */
  thumbName?: string | null;
  /** 极低分辨率占位（base64）。可选。 */
  lqip?: string;
  /** 原图字节数与像素尺寸（客户端撑布局用）。可选。 */
  bytes?: number;
  width?: number;
  height?: number;
}

/** 元数据块：本体不下发（`omitted:true`），但 key 一定在。 */
export function remoteImageMetadataBlock(input: RemoteImageMetaInput): RemoteBlock {
  const mimeType = IMAGE_MIME_RE.test(String(input.mimeType || "")) ? String(input.mimeType) : "image/jpeg";
  return {
    type: "image",
    key: input.key,
    mimeType,
    omitted: true,
    ...(input.thumbName ? { thumb: input.thumbName } : {}),
    ...(input.lqip ? { lqip: input.lqip } : {}),
    ...(typeof input.bytes === "number" && input.bytes > 0 ? { bytes: Math.floor(input.bytes) } : {}),
    ...(typeof input.width === "number" && input.width > 0 ? { width: Math.floor(input.width) } : {}),
    ...(typeof input.height === "number" && input.height > 0 ? { height: Math.floor(input.height) } : {}),
    ...(input.label ? { label: input.label } : {}),
  } as RemoteBlock;
}
