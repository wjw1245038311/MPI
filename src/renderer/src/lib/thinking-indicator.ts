import type { ThreadState, ViewMessage } from "./types";

/**
 * 把已等待秒数格式化成给人看的字符串：`59s` / `1m03s`。
 *
 * 本地大模型 prefill 到分钟级不罕见，纯秒数（`137s`）读起来费劲。
 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
}

/**
 * 聊天区是否显示「思考中」占位行（prefill 等待指示器）。
 *
 * pi 只在 LLM 响应头到达后才发 assistant message_start；本地模型 prefill 可能
 * 长达数十秒，期间 isStreaming=true 但 streaming=null、也没有工具卡在跑——
 * 没有显性反馈时界面看起来像卡死。本谓词覆盖三个窗口：
 *   1. 发送后 → agent_start（含冷启动建桥）；
 *   2. LLM 请求发出 → 响应头到达（prefill，本地模型的主要痛点）；
 *   3. 工具执行完 → 下一次 LLM 响应头到达（第二轮 prefill）。
 */
export function shouldShowThinkingIndicator(
  t: Pick<ThreadState, "isStreaming" | "compacting" | "toolRuns"> | null | undefined,
  streaming: ViewMessage | null | undefined,
): boolean {
  if (!t || !t.isStreaming) return false;
  // 压缩进行中 → composer 侧已有自己的指示（按钮 busy + 提示）。
  if (t.compacting) return false;
  const runs = t.toolRuns ?? {};
  for (const key of Object.keys(runs)) {
    // 工具卡已在展示活动，不再叠加占位行。
    if (runs[key]?.running) return false;
  }
  // 判据是「还没有任何可见内容」，而不是「assistant 消息还没开始」：
  // pi 在 **HTTP 响应头到达**时就发 message_start，而本地模型（llama-server 等）的
  // 响应头通常早于 prefill 完成——那时 streaming 已非空却一个块都没有。
  // （2026-09-26 真机：本地模型 prefill 期间一直等不到占位行，就是因为这条判早了。）
  return !hasVisibleContent(streaming);
}

/** 流式消息里是否已有用户看得见的东西（正文 / 思考 / 工具调用）。 */
function hasVisibleContent(message: ViewMessage | null | undefined): boolean {
  const blocks = message?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  return blocks.some((block) => {
    if (!block) return false;
    if (block.type === "toolCall") return true; // 工具卡本身就是可见活动
    if (block.type === "thinking") return !!block.thinking;
    if (block.type === "text") return !!block.text;
    return false;
  });
}
