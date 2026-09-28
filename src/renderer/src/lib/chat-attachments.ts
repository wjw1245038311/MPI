/**
 * 用户消息文本里的**视频附件引用**（桌面端）。
 *
 * pi 的历史里，带附件的用户消息长这样（主机 processAttachments/stageRemoteVideos 写的）：
 *   `<file name="video-…mp4" path="C:\…\mpi-clipboard\….mp4" attach="video" note="…" />`
 * 直接渲染的话，用户会在自己气泡里看到那一整行原始标签——所以这里把它剥出来，
 * 交给 `<video src=chatatt://…>` 内联播放。
 *
 * ⚠️ 解析规则必须与主机侧 `src/main/remote/video-refs.ts` 的 `splitVideoRefs` **同源**：
 * 格式一旦两边漂移，症状是“气泡里冒出原始标签”或“视频不显示”。
 * `scripts/test-chat-attachments.mjs` 会同时 import 两侧、用同一批样例对比行为。
 */

const VIDEO_REF_ATTR = 'attach="video"';
const VIDEO_REF_RE = /<file\s+name="([^"]*)"\s+path="([^"]*)"\s+attach="video"[^>]*\/>/g;

export interface VideoRef {
  /** 落盘文件名（chatatt 协议就是按它取文件的） */
  name: string;
  /** 绝对路径（仅用于展示/排错，渲染层不直接读它） */
  path: string;
}

/** 把文本里的视频引用剥出来。没有标记时原样返回（零成本，不影响普通消息）。 */
export function splitVideoRefs(text: string): { text: string; refs: VideoRef[] } {
  if (!text || !text.includes(VIDEO_REF_ATTR)) return { text, refs: [] };
  const refs: VideoRef[] = [];
  const cleaned = text.replace(VIDEO_REF_RE, (_all, name: string, path: string) => {
    refs.push({ name: String(name), path: String(path) });
    return "";
  });
  return { text: refs.length ? cleaned.trim() : text, refs };
}

/**
 * 渲染层取视频字节的 URL（handler 见 `src/main/chat-attachment-protocol.ts`）。
 *
 * 名字走 query 而不是 hostname：standard 协议的 hostname 会被小写化，而落盘名可能含大写。
 */
export function chatAttachmentUrl(name: string): string {
  return `chatatt://attachment/?name=${encodeURIComponent(name)}`;
}
