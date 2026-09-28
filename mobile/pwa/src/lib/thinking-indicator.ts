/**
 * prefill 等待指示器（「思考中 · Ns」）——与桌面端 `src/renderer/src/lib/thinking-indicator.ts`、
 * Android `ui/ThinkingIndicator.kt` 同一套语义。
 *
 * 背景：pi 只在 LLM 响应头到达后才发 assistant message_start；本地模型 prefill 可能
 * 长达数十秒，期间 running=true 但 streaming=null（或 streaming 非空却一个块都没有）、
 * 也没有工具卡在跑——没有显性反馈时界面看起来像卡死。本谓词覆盖三个窗口：
 *   1. 发送后 → agent_start / LLM 响应头到达；
 *   2. LLM 请求发出 → 响应头到达（prefill，本地模型的主要痛点）；
 *   3. 工具执行完 → 下一次 LLM 响应头到达（第二轮 prefill）。
 */

/** 消息块的最小结构切片（与 thread-session.ts 的 ViewBlock 兼容，避免值导入）。 */
interface BlockLike {
  type: string;
  text?: string;
  data?: string;
  running?: boolean;
}

export interface ThinkingIndicatorInput {
  /** agent 回合是否在进行（PWA：view.running || summary.state === "running"）。 */
  running: boolean;
  compacting: boolean;
  messages: Array<{ blocks: BlockLike[] }>;
  streaming: { blocks: BlockLike[] } | null;
}

/**
 * 聊天区是否显示「思考中」占位行。
 *
 * 判据是「还没有任何可见内容」，而不是「assistant 消息还没开始」：pi 在 **HTTP 响应头
 * 到达**时就发 message_start，而本地模型（llama-server 等）的响应头通常早于 prefill
 * 完成——那时 streaming 已非空却一个块都没有。（2026-09-26 桌面真机踩过：判据写早了，
 * prefill 期间一直等不到占位行。）
 */
export function shouldShowThinkingIndicator(
  view: ThinkingIndicatorInput | null | undefined,
): boolean {
  if (!view || !view.running) return false;
  // 压缩进行中 → composer/上下文 chip 侧已有自己的指示。
  if (view.compacting) return false;
  for (const message of view.messages) {
    // 工具卡已在展示活动，不再叠加占位行。
    if (message.blocks.some((b) => b.type === "tool" && b.running)) return false;
  }
  return !hasVisibleContent(view.streaming);
}

/** 流式消息里是否已有用户看得见的东西（正文 / 思考 / 图片 / 工具调用）。 */
function hasVisibleContent(message: { blocks: BlockLike[] } | null | undefined): boolean {
  const blocks = message?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  return blocks.some((block) => {
    if (block.type === "tool") return true; // 工具卡本身就是可见活动
    if (block.type === "image") return !!block.data;
    return !!block.text; // text / thinking
  });
}

/**
 * 把已等待秒数格式化成给人看的字符串：`59s` / `1m03s`。
 * 本地大模型 prefill 到分钟级不罕见，纯秒数（`137s`）读起来费劲。
 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
}
