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
  // `application/octet-stream` 是「**不知道**是什么」（不是「是一堆字节」）：直接采信它
  // 就会把 xlsx/zip 全落成 `.bin`，桌面预览与手机「打开方式」都认不出类型
  // （2026-11-04 测试.xlsx 事故：agent 递交时 mime 就是 octet-stream）。
  // 所以它和「表里没有」同等对待：继续用名字后缀。
  if (known && mime !== "application/octet-stream") return known;
  // mime 不认识时用原名后缀（比如 .docx/.xlsx 这种没必要穷举的）
  const ext = name ? extname(String(name)).toLowerCase() : "";
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".bin";
};

/** 图片/音频扩展名集合（仅用于在 mime 缺失时按名字推大类）。 */
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".heif", ".avif"]);
export const AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav", ".weba"]);

export const isImageFile = (name: string): boolean => IMAGE_EXTS.has(extname(String(name || "")).toLowerCase());
export const isAudioFile = (name: string): boolean => AUDIO_EXTS.has(extname(String(name || "")).toLowerCase());

/**
 * 对象库路径 → MIME（按扩展名反查 MEDIA_EXT_BY_MIME）。
 *
 * 快照里音/文件块的 `mimeType` 用它推（客户端据此选渲染器）。重名扩展名取先登记的那个
 * （如 `.m4a` → `audio/mp4`），足够客户端判断大类。
 */
export function mediaMimeForPath(path: string): string {
  const ext = extname(String(path || "")).toLowerCase();
  for (const [mime, candidate] of Object.entries(MEDIA_EXT_BY_MIME)) {
    if (candidate === ext) return mime;
  }
  return "application/octet-stream";
}

/** 缩略图文件名（P3）：`<name>.thumb.<ext>`。视频的历史名是 `<name>.poster.jpg`，两者都要认。 */
export const thumbNameFor = (name: string, mimeType = "image/jpeg"): string =>
  `${name}.thumb${posterExtForMime(mimeType)}`;

/** 占位图文件名（LQIP）：`<name>.lqip.<ext>`。 */
export const lqipNameFor = (name: string, mimeType = "image/jpeg"): string =>
  `${name}.lqip${posterExtForMime(mimeType)}`;

/**
 * 从**派生附件名**反推父名（`<key>.thumb.jpg` / `<key>.poster.jpg` / `<key>.lqip.jpg` → `<key>`）。
 *
 * 为什么要它（2026-11-06）：附件授权是按「会话引用过的名字」白名单做的，而白名单里
 * 只会有原图 key（引用里写的就是它）——客户端按 `thumb` 字段拉缩略图时如果按精确名
 * 校验，**主机重启后**（内存白名单清空、走回源扇描）就会被 NOT_FOUND 掐掉。
 * 派生名的授权应当只看它的父名：父名在会话作用域内，它的缩略图/占位图也就够格。
 *
 * 只认固定后缀，避免把任意文件名当“父名”放行。
 */
export function derivedAttachmentBase(name: string): string | null {
  const match = /^(.+)\.(?:thumb|poster|lqip)\.[a-z0-9]+$/i.exec(String(name || ""));
  if (!match) return null;
  const base = match[1];
  return base && base.length <= 200 ? base : null;
}

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
  /** 原始字节数（`size` 属性；老引用没有 → undefined）。 */
  size?: number;
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
 * `path` 看起来是不是一个**真实存在过**的绝对路径。
 *
 * 为什么需要（2026-11-06 真机事故）：工具结果里可能只是**贴了段代码/文档**，里面有
 * `<file … attach="video" poster="…" />` 这种示例。以前不看路径形状就照单全收，于是
 * 示例里的占位符（`${attr(name)}`、`…`）被当成真附件，生成两个打不开的「视频」卡片
 * （手机端报 `attachment.fetch NOT_FOUND`）。
 *
 * 真引用的 path 一定是绝对路径，且不含模板占位符；文档/代码示例几乎必然带 `${`、`…`、`<`。
 */
export function isPlausibleMediaPath(path: string): boolean {
  if (!path) return false;
  if (path.includes("${") || path.includes("…") || path.includes("<") || path.includes(">")) return false;
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
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
    // 路径形状不像真的（文档/代码里的示例）→ 当成普通文本，不生成附件
    if (!isPlausibleMediaPath(path)) return all;
    const declared = attrs.kind as MediaKind | undefined;
    const kind: MediaKind =
      attach === "video"
        ? "video"
        : declared && ["image", "audio", "video", "file"].includes(declared)
          ? declared
          : mediaKindForMime(undefined, attrs.label || name);
    const thumb = attrs.thumb || attrs.poster || undefined;
    const size = Number.parseInt(attrs.size || "", 10);
    refs.push({
      name,
      path,
      kind,
      ...(thumb ? { thumb } : {}),
      ...(attrs.key ? { key: attrs.key } : {}),
      ...(attrs.label ? { label: attrs.label } : {}),
      ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    });
    return "";
  });
  return { text: refs.length ? cleaned.trim() : text, refs };
}

/** 兼容别名（旧调用方名字；行为已泛化到媒体）。 */
export const splitVideoRefs = splitMediaRefs;

/**
 * 把一条消息的 `content` 里的媒体引用剥掉（**事件通道**用，快照有自己的路径）。
 *
 * 为什么单独一个纯函数：2026-11-04 真机发现事件通道只处理用户消息，助手自己写的
 * `<file … attach="media" … />`（`mpi_attach_file` 要求 agent 把引用原样贴出来）
 * 会直接当正文显示在手机上。这段判定必须能脱离 Electron 单测
 * （`test-chat-attachments` 的 1e 组），而 ipc.ts 拖整条依赖链、导不进去。
 *
 * 只剥 `type: "text"` 块里的引用，其它块（image/thinking/toolCall…）原样返回；
 * 没有引用时**返回原对象**（不制造无谓拷贝，事件通道每帧都跑）。
 */
export function stripMediaRefsFromContent(content: unknown): { content: unknown; refs: MediaRef[] } {
  const parts: any[] | null =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? content
        : null;
  if (!parts) return { content, refs: [] };
  const refs: MediaRef[] = [];
  let changed = false;
  const next = parts.map((part: any) => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    const split = splitMediaRefs(part.text);
    if (!split.refs.length) return part;
    refs.push(...split.refs);
    changed = true;
    return { ...part, text: split.text };
  });
  if (!changed) return { content, refs: [] };
  // 字符串输入 → 字符串输出（保持形状，否则主机的 remoteSafeEventValue 会把它当数组）。
  if (typeof content === "string") return { content: String((next[0] as any)?.text ?? ""), refs };
  return { content: next, refs };
}

/** `<file … />` 标签与属性解析（两段式：先括标签，再逐个取属性）。 */
const FILE_TAG_RE = /<file\s+([^>]*?)\s*\/>/g;
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"/g;
