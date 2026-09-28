/**
 * 桌面端取「聊天里的视频附件」字节的 URL 拼装（主机侧 handler 见
 * `src/main/chat-attachment-protocol.ts`）。
 *
 * 为什么名字走 query 而不是 hostname：standard 协议的 hostname 会被 URL 解析器**小写化**，
 * 而落盘名可能含大写。
 *
 * 引用信封（`<file … attach="video" … />`）到「视频附件」的解析在 `store.ts` 的
 * `parseUserMessage`（它本来就在做 `<file>` 信封 → 附件的转换，不该在这里再来一遍）。
 */

export function chatAttachmentUrl(name: string): string {
  return `chatatt://attachment/?name=${encodeURIComponent(name)}`;
}
