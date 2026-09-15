/**
 * 手机端历史下发上限（纯逻辑，便于单测）。
 *
 * 背景：这里原来写死 `slice(-80)`，是用户「对话往上拉不动」的直接原因——
 * 更早的消息根本没下发给手机。现在放宽到 400 条，并用字节预算兜底：
 * 超大历史（多轮长工具输出/图片）从最旧的开始丢，保证单帧远低于 relay 的
 * MAX_FRAME_BYTES(32MB) 与手机端的解码/内存能力。
 */
import type { RemoteMessage } from "./protocol";

/**
 * 原始 pi 条目上限（含 toolResult / 中间 assistant 消息）。
 *
 * ⚠️ 这不是"用户能看到多少"——一个回合里 agent 可能产生上百条 toolResult，
 * 它们会被 remoteMessages() 折叠进同一个 assistant 回合。2026-09-16 真机取证：
 * total=400 原始条目 → rendered=17 条会话消息，用户「往上拉两三页就不行」。
 * 所以这里要放宽（只为控制解析成本），能拉多远由 MAX_RENDERED_MESSAGES 决定。
 */
export const MAX_REMOTE_RAW_MESSAGES = 6000;

/** 下发到手机的会话条目上限——**这个才是"能往上拉多远"**。 */
export const MAX_RENDERED_MESSAGES = 300;

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

/** 条数上限：从最新往回保留 MAX_RENDERED_MESSAGES 条会话条目。 */
export function capRenderedHistory(messages: RemoteMessage[]): RemoteMessage[] {
  return messages.length > MAX_RENDERED_MESSAGES ? messages.slice(-MAX_RENDERED_MESSAGES) : messages;
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
