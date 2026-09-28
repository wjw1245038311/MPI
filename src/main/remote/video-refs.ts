/**
 * 远程**视频附件**的引用协议（主机侧）。
 *
 * 背景：视频要「像图片一样在对话框里直接看」，所以字节得内联下发给客户端；但 agent
 * 只会读文件、看不了视频，所以落盘后**还得**给 agent 留一条路径引用。两条诉求用同一个
 * 承载物：
 *
 *   <file name="video-….mp4" path="/…/temp/mpi-clipboard/….mp4" attach="video" note="…" />
 *
 * 普通附件引用（没有 `attach="video"`）保持原样不动，只有带标记的才会被剥出来换成
 * 可播放的 `video` 块——见 `ipc.ts` 的 remoteMessages。
 *
 * 写入与解析放在同一个文件里，避免两边格式漂移（regex 与模板必须同时改）。
 */
import { extname } from "node:path";

/** 标记普通 <file> 引用与“可播放视频引用”的属性。 */
export const VIDEO_REF_ATTR = 'attach="video"';
const VIDEO_REF_RE = /<file\s+name="([^"]*)"\s+path="([^"]*)"\s+attach="video"[^>]*\/>/g;

/**
 * 单个视频可以**内联进快照**的原始字节上限（base64 后 ≈4MB）。
 *
 * 超过它的视频照样作为视频附件保存、照样生成 `attach="video"` 引用（客户端点开就按需拉，
 * 见 attachment.fetch），只是不再随快照下发字节而已——这是 2026-09-28 之后的大小分界：
 * 快照再也不会被几 MB 的视频撑爆，也不必再把大视频降级成普通文件卡片。
 */
export const REMOTE_VIDEO_INLINE_MAX_BYTES = 3_000_000;

/**
 * 能被当作「视频附件」处理的原始字节上限（落盘附件区 + 生成引用 + 客户端可点开播放）。
 *
 * 超过这个值仍走普通 `<file>` 引用（不进附件区、气泡里不可播）——那是给 agent 读的文件，
 * 不是给用户看的媒体。128MB 是「手机上看一段录屏/短片」的现实上限，也远低于附件区总量上限。
 */
export const REMOTE_VIDEO_MAX_BYTES = 128 * 1024 * 1024;

/**
 * 一次快照里视频字节的**总预算**（base64 字符），**最新优先**。
 *
 * 为什么单独预算：快照总预算只有 7.6MB（MAX_INNER_ENVELOPE_BYTES 去掉 headroom），
 * 而视频是最容易把它撑爆的东西，又是用户希望保留的内容——超出预算时宁可把**更早的**
 * 视频降级成占位卡片（`omitted: true`），也不让它去挤历史。
 *
 * 自 2026-09-28 起这个预算只服务于**小视频的内联**（≤ REMOTE_VIDEO_INLINE_MAX_BYTES）；
 * 大视频一律走按需拉取，不占这里。
 */
export const REMOTE_VIDEO_BASE64_BUDGET = 4_500_000;

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

/** 生成给 agent 看的视频引用（带 `attach="video"` 标记，客户端据此换成播放器）。 */
export function videoRefEnvelope(name: string, abs: string): string {
  return `\n\n<file name="${attr(name)}" path="${attr(abs)}" attach="video" note="video attachment; inline-playable in MPI clients" />`;
}

/**
 * 把文本里的视频引用剥出来（只对带 `attach="video"` 的引用生效）。
 *
 * 返回清理后的文本（去掉引用后 trim）与引用列表；没有标记时原样返回，零成本。
 */
export function splitVideoRefs(text: string): { text: string; refs: Array<{ name: string; path: string }> } {
  if (!text || !text.includes(VIDEO_REF_ATTR)) return { text, refs: [] };
  const refs: Array<{ name: string; path: string }> = [];
  const cleaned = text.replace(VIDEO_REF_RE, (_all, name: string, path: string) => {
    refs.push({ name: String(name), path: String(path) });
    return "";
  });
  return { text: refs.length ? cleaned.trim() : text, refs };
}
