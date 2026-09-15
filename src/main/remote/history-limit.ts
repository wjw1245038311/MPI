/**
 * 手机端历史下发上限（纯逻辑，便于单测）。
 *
 * 背景：这里原来写死 `slice(-80)`，是用户「对话往上拉不动」的直接原因——
 * 更早的消息根本没下发给手机。现在放宽到 400 条，并用字节预算兜底：
 * 超大历史（多轮长工具输出/图片）从最旧的开始丢，保证单帧远低于 relay 的
 * MAX_FRAME_BYTES(32MB) 与手机端的解码/内存能力。
 */
import type { RemoteMessage } from "./protocol";

/** 手机端单次历史的最大条数。 */
export const MAX_REMOTE_HISTORY = 400;

/** 单次历史响应的净字节预算（正文 + 图片估算）；超了从最旧的开始丢。 */
export const REMOTE_HISTORY_BYTE_BUDGET = 6_000_000;

/** 估算单条消息下发后的字节数（正文长度 + 图片 base64 长度 + 固定开销）。 */
export function remoteMessageSize(message: RemoteMessage): number {
  let size = 200;
  for (const block of message.blocks || []) {
    size += (block.text?.length || 0) + (block.result?.length || 0) + (block.data?.length || 0) + 40;
  }
  size += message.text?.length || 0;
  return size;
}

/** 从最旧的开始丢，直到总量进预算（**至少保留最后一条**——空历史比超预算更糟）。 */
export function trimRemoteHistory(
  messages: RemoteMessage[],
  budget = REMOTE_HISTORY_BYTE_BUDGET,
): RemoteMessage[] {
  const sizes = messages.map(remoteMessageSize);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  while (start < messages.length - 1 && total > budget) {
    total -= sizes[start];
    start += 1;
  }
  return start === 0 ? messages : messages.slice(start);
}
