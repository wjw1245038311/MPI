/**
 * 「插话撤回」的纯逻辑（2026-10-19）。
 *
 * 背景：Alt+Enter 的「立即插入」= pi 的 `steer`，消息先进 pi 的 `_steeringMessages`
 * 队列，直到下一个 LLM 调用边界才作为 user 消息注入上下文（pi 的 agent-session 在
 * `message_start` 时才把它出队）。所以「发出去了但模型还没看到」这个窗口是真实存在的，
 * `clear_queue` 可以整队撤回。
 *
 * 但 pi 只能**整队清空**（没有按条撤回），所以撤回后必须把文本原样交还给用户——
 * 落到「待处理后续」卡片（可 ✎ 再编辑 / ⚡ 再插入），而不是静默丢掉。
 *
 * 抽成纯函数是为了能被单测钉住（回填规则比 UI 更容易出错）。
 */
import type { PendingFollowUp } from "./types";

export interface PiQueueState {
  /** pi 队列里的 steering 文本（已发出、尚未注入上下文）。 */
  steering: string[];
  /** pi 队列里的 follow-up 文本（等待本轮结束后发送）。 */
  followUp: string[];
}

export const EMPTY_PI_QUEUE: PiQueueState = Object.freeze({ steering: [], followUp: [] }) as PiQueueState;

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** 把任意来源（IPC 返回值 / queue_update 事件）规整成 [PiQueueState]。 */
export function normalizePiQueue(value: unknown): PiQueueState {
  const source = (value || {}) as Record<string, unknown>;
  return { steering: asStrings(source.steering), followUp: asStrings(source.followUp) };
}

/** 队列里一共有几条待投递消息。 */
export function piQueueCount(queue: PiQueueState | null | undefined): number {
  return (queue?.steering?.length || 0) + (queue?.followUp?.length || 0);
}

/** 队列里的文本（steering 在前，保持 pi 的投递顺序）。 */
export function piQueueTexts(queue: PiQueueState | null | undefined): string[] {
  return [...(queue?.steering || []), ...(queue?.followUp || [])];
}

/**
 * 撤回后的回填：把清掉的文本并进已有的「待处理后续」卡片（没有就新建一张）。
 *
 * 保留原有卡片里的图片 / 文件 / 引用（`clear_queue` 只返回文本，附件信息丢了，
 * 但已有卡片上的附件不该被这次操作抹掉）；文本按「已有内容 → steering → followUp」顺序拼接。
 * 什么都没清到 → 原样返回（`null` 就还是 `null`，不凭空造一张空卡片）。
 */
export function mergeRetractedQueue(
  pending: PendingFollowUp | null | undefined,
  cleared: unknown,
): PendingFollowUp | null {
  const queue = normalizePiQueue(cleared);
  const added = piQueueTexts(queue);
  if (added.length === 0) return pending ?? null;
  const existingText = pending?.text?.trim() || "";
  const text = [existingText, ...added].filter(Boolean).join("\n\n");
  return {
    text,
    images: pending?.images || [],
    files: pending?.files || [],
    ...(pending?.htmlReferences ? { htmlReferences: pending.htmlReferences } : {}),
    ...(pending?.quotes ? { quotes: pending.quotes } : {}),
  };
}
