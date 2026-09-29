/**
 * 远程**视频附件**的引用协议（主机侧）。
 *
 * 背景：视频要「像图片一样在对话框里直接看」。但 agent 只会读文件、看不了视频，
 * 所以落盘后**还得**给 agent 留一条路径引用。两条诉求用同一个承载物：
 *
 *   <file name="video-….mp4" path="…" attach="video" poster="…-video-….mp4.poster.jpg" />
 *
 * 自 2026-09-29（阶段2）起，快照**不再下发视频字节**（只下发上面那张封面图）——
 * 原片由客户端点开时按需拉（见 attachment.fetch）。好处：快照从几 MB 降到几十 KB，
 * 历史不再被视频挤掉；代价是点开到出画面要等一小段（有进度条与封面顶替）。
 *
 * 普通附件引用（没有 `attach="video"`）保持原样不动，只有带标记的才会被剥出来换成
 * 可播放的 `video` 块——见 `ipc.ts` 的 remoteMessages。
 *
 * 写入与解析放在同一个文件里，避免两边格式漂移（regex 与模板必须同时改）。
 */
import { extname } from "node:path";

/** 标记普通 <file> 引用与“可播放视频引用”的属性。 */
export const VIDEO_REF_ATTR = 'attach="video"';
/** 媒体引用的标记（P3 起统一形式）：与 `attach="video"` 并列存在，两者都要认。 */
export const MEDIA_REF_ATTR = 'attach="media"';

/**
 * 单个视频可以**整帧内联上传**的原始字节上限（base64 后 ≈4MB）。
 *
 * 只关于**上传**（PWA 选中视频后走 `videos` 通道 base64 内联上传，受 8MB envelope 硬上限制约），
 * 与「快照里下发多少字节」已无关：自 2026-09-29 起快照不下发任何视频字节，
 * 只下发一张封面图（见 VIDEO_POSTER_MAX_BYTES 与 attachment.fetch）。
 */
export const REMOTE_VIDEO_UPLOAD_MAX_BYTES = 3_000_000;

/**
 * 能被当作「视频附件」处理的原始字节上限（落盘附件区 + 生成引用 + 客户端可点开播放）。
 *
 * 超过这个值仍走普通 `<file>` 引用（不进附件区、气泡里不可播）——那是给 agent 读的文件，
 * 不是给用户看的媒体。128MB 是「手机上看一段录屏/短片」的现实上限，也远低于附件区总量上限。
 */
export const REMOTE_VIDEO_MAX_BYTES = 128 * 1024 * 1024;

/**
 * 封面图（首帧）的原始字节上限。
 *
 * 为什么卡这么小：封面要**跟着每一次快照**下发（用户滚动历史时得立刻看到画面），
 * 而快照有 8MB 硬上限。160KB 足够一张 640px 宽的 JPEG 首帧（实测通常 20–60KB）。
 */
export const VIDEO_POSTER_MAX_BYTES = 160_000;

/** 封面允许的 MIME（与三端生成侧一致）。 */
export const VIDEO_POSTER_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * 一次快照里封面图字节的**总预算**（base64 字符），**最新优先**。
 *
 * 超出预算时只把**更早的**封面降级成深色卡片（视频本体仍可点开按需拉），保留视频与历史。
 */
export const VIDEO_POSTER_BASE64_BUDGET = 2_000_000;

/** 封面文件命名：在视频文件名后追加后缀（同一目录，不会与视频名碰撞）。 */
export const posterNameFor = (videoName: string, mimeType = "image/jpeg"): string =>
  `${videoName}.poster${posterExtForMime(mimeType)}`;

/** 按封面文件名推断 MIME（客户端要正确的 mime 才能渲染）。 */
export const posterMimeForName = (name: string): string => {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
};

/** 按 MIME 给出封面文件扩展名（落盘时用）。 */
export const posterExtForMime = (mimeType: string): string => {
  const lower = String(mimeType || "").toLowerCase();
  if (lower === "image/png") return ".png";
  if (lower === "image/webp") return ".webp";
  return ".jpg";
};

export const VIDEO_MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

export const VIDEO_EXT_BY_MIME: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/x-m4v": ".m4v",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
};

export const videoMimeForPath = (path: string): string => VIDEO_MIME_BY_EXT[extname(path).toLowerCase()] || "video/mp4";

/**
 * 媒体附件（P3）的**通用**扩展名表：图 / 音 / 视 / 常见文档。
 *
 * 为什么需要它：内容寻址的对象文件名带扩展名（服务端靠它给 Content-Type，快照靠它推 mime），
 * 而视频那张表（VIDEO_EXT_BY_MIME）对图片/音频一无所知——不补就会把 png/音频都落成 `.mp4`。
 */
export const MEDIA_EXT_BY_MIME: Record<string, string> = {
  ...VIDEO_EXT_BY_MIME,
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/avif": ".avif",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/flac": ".flac",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".weba",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/json": ".json",
  "application/octet-stream": ".bin",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
};

/** 附件大类（决定客户端怎么展示：图/音/视/普通文件）。 */
export type MediaKind = "image" | "audio" | "video" | "file";

/** 按 mime 给大类；mime 缺失/不认识 → 看扩展名；都不认识 → file。 */
export function mediaKindForMime(mimeType: string | undefined, name?: string): MediaKind {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (!mime && name) {
    const ext = extname(String(name)).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return "image";
    if (AUDIO_EXTS.has(ext)) return "audio";
    if (Object.values(VIDEO_EXT_BY_MIME).includes(ext)) return "video";
  }
  return "file";
}

/** mime → 落盘扩展名（不认识就给 .bin，不猜）。 */
export const mediaExtForMime = (mimeType: string | undefined, name?: string): string => {
  const mime = String(mimeType || "").toLowerCase();
  const known = MEDIA_EXT_BY_MIME[mime];
  if (known) return known;
  // mime 不认识时用原名后缀（比如 .docx/.xlsx 这种没必要穷举的）
  const ext = name ? extname(String(name)).toLowerCase() : "";
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".bin";
};

/** 图片/音频扩展名集合（仅用于在 mime 缺失时按名字推大类）。 */
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".heif", ".avif"]);
export const AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav", ".weba"]);

export const isImageFile = (name: string): boolean => IMAGE_EXTS.has(extname(String(name || "")).toLowerCase());
export const isAudioFile = (name: string): boolean => AUDIO_EXTS.has(extname(String(name || "")).toLowerCase());

/** 缩略图文件名（P3）：`<name>.thumb.<ext>`。视频的历史名是 `<name>.poster.jpg`，两者都要认。 */
export const thumbNameFor = (name: string, mimeType = "image/jpeg"): string =>
  `${name}.thumb${posterExtForMime(mimeType)}`;

/** <file> 属性值转义（会话名等也可能含引号，与 ipc.ts 的 attr 同规则）。 */
const attr = (value: string): string => String(value).replace(/"/g, "&quot;");

/** 生成给 agent 看的视频引用（带 `attach="video"` 标记与可选封面名 / 内容 key / 可读名）。 */
export function videoRefEnvelope(
  name: string,
  abs: string,
  posterName?: string,
  extra?: { key?: string; label?: string },
): string {
  const label = extra?.label ? ` label="${attr(extra.label)}"` : "";
  const key = extra?.key ? ` key="${attr(extra.key)}"` : "";
  const poster = posterName ? ` poster="${attr(posterName)}"` : "";
  return `\n\n<file name="${attr(name)}"${label} path="${attr(abs)}" attach="video"${key}${poster} note="video attachment; inline-playable in MPI clients" />`;
}

/** 一条媒体引用的解析结果。 */
export interface MediaRef {
  name: string;
  path: string;
  /** 大类（P3）：客户端据此选展示方式（图/音/视/普通文件）。 */
  kind: MediaKind;
  /** 缩略图文件名（图/视有；音/文件无）。视频的历史属性叫 `poster`，统一映射到这里。 */
  thumb?: string;
  /** `sha256:<hex>`（内容寻址后才带；老消息没有）。 */
  key?: string;
  /** 可读的原文件名（老消息没有，从 key 也推不出来）。 */
  label?: string;
}

/** 兼容别名：历史上这里只有视频。 */
export type VideoRef = MediaRef;

/** 生成给 agent 看的媒体引用（P3 统一形式；图/音/视/文件都用它）。 */
export function mediaRefEnvelope(args: {
  name: string;
  abs: string;
  kind: MediaKind;
  key?: string;
  label?: string;
  thumb?: string;
  size?: number;
}): string {
  const parts = [
    `name="${attr(args.name)}"`,
    args.label ? `label="${attr(args.label)}"` : "",
    `path="${attr(args.abs)}"`,
    'attach="media"',
    `kind="${args.kind}"`,
    args.key ? `key="${attr(args.key)}"` : "",
    args.thumb ? `thumb="${attr(args.thumb)}"` : "",
    args.size ? `size="${Math.floor(args.size)}"` : "",
    'note="media attachment; playable/viewable in MPI clients"',
  ].filter(Boolean);
  return `\n\n<file ${parts.join(" ")} />`;
}

/**
 * 把文本里的媒体引用剥出来（`attach="video"` 或 `attach="media"`）。
 *
 * 实现从「一条巨长的正则」改成了「先括出 `<file … />` 标签，再逐个解析属性」：
 * P3 的属性变多了（kind/thumb/size），顺序也不再固定，巨正则太难维护。
 * 没带标记的普通 `<file>` 引用**原样保留**（它们是给 agent 的输入文件，不是媒体）。
 */
export function splitMediaRefs(text: string): { text: string; refs: MediaRef[] } {
  if (!text || (!text.includes(VIDEO_REF_ATTR) && !text.includes(MEDIA_REF_ATTR))) return { text, refs: [] };
  const refs: MediaRef[] = [];
  const cleaned = text.replace(FILE_TAG_RE, (all: string, rawAttrs: string) => {
    const attrs: Record<string, string> = {};
    for (const match of rawAttrs.matchAll(ATTR_RE)) attrs[match[1]] = match[2];
    const attach = attrs.attach || "";
    if (attach !== "video" && attach !== "media") return all;
    const name = attrs.name || "";
    const path = attrs.path || "";
    if (!name || !path) return all;
    const declared = attrs.kind as MediaKind | undefined;
    const kind: MediaKind =
      attach === "video"
        ? "video"
        : declared && ["image", "audio", "video", "file"].includes(declared)
          ? declared
          : mediaKindForMime(undefined, attrs.label || name);
    const thumb = attrs.thumb || attrs.poster || undefined;
    refs.push({
      name,
      path,
      kind,
      ...(thumb ? { thumb } : {}),
      ...(attrs.key ? { key: attrs.key } : {}),
      ...(attrs.label ? { label: attrs.label } : {}),
    });
    return "";
  });
  return { text: refs.length ? cleaned.trim() : text, refs };
}

/** 兼容别名（旧调用方名字；行为已泛化到媒体）。 */
export const splitVideoRefs = splitMediaRefs;

/** `<file … />` 标签与属性解析（两段式：先括标签，再逐个取属性）。 */
const FILE_TAG_RE = /<file\s+([^>]*?)\s*\/>/g;
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"/g;
