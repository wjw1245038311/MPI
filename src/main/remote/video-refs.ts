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
/**
 * 视频引用。属性顺序固定：`name` › 可选 `label` › `path` › `attach` › 可选 `key` › 可选 `poster`。
 *
 * 内容寻址（P1）后：`name` 就是 SHA-256 key（老消息里是 `<uuid>-原名.mp4`），`key="sha256:…"`
 * 显式带一份（便于迁移期区分「已内容寻址」与「尚未」），`label` 给出可读的文件名。
 * 三个新属性全部可选 → 历史消息永远不需要重写。
 */
const VIDEO_REF_RE = /<file\s+name="([^"]*)"(?:\s+label="([^"]*)")?\s+path="([^"]*)"\s+attach="video"(?:\s+key="([^"]*)")?(?:\s+poster="([^"]*)")?[^>]*\/>/g;

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

/** 一条视频引用的解析结果。 */
export interface VideoRef {
  name: string;
  path: string;
  poster?: string;
  /** `sha256:<hex>`（内容寻址后才带；老消息没有）。 */
  key?: string;
  /** 可读的原文件名（老消息没有，从 key 也推不出来）。 */
  label?: string;
}

/**
 * 把文本里的视频引用剥出来（只对带 `attach="video"` 的引用生效）。
 *
 * 返回清理后的文本（去掉引用后 trim）与引用列表（含可选封面文件名）；
 * 没有标记时原样返回，零成本。
 */
export function splitVideoRefs(text: string): { text: string; refs: VideoRef[] } {
  if (!text || !text.includes(VIDEO_REF_ATTR)) return { text, refs: [] };
  const refs: VideoRef[] = [];
  const cleaned = text.replace(
    VIDEO_REF_RE,
    (_all, name: string, label: string | undefined, path: string, key: string | undefined, poster: string | undefined) => {
      refs.push({
        name: String(name),
        path: String(path),
        ...(poster ? { poster: String(poster) } : {}),
        ...(key ? { key: String(key) } : {}),
        ...(label ? { label: String(label) } : {}),
      });
      return "";
    },
  );
  return { text: refs.length ? cleaned.trim() : text, refs };
}
