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
  // assistant 消息已开始 → 由消息内既有的「思考中」/流式圆点接管。
  if (streaming) return false;
  // 压缩进行中 → composer 侧已有自己的指示（按钮 busy + 提示）。
  if (t.compacting) return false;
  const runs = t.toolRuns ?? {};
  for (const key of Object.keys(runs)) {
    // 工具卡已在展示活动，不再叠加占位行。
    if (runs[key]?.running) return false;
  }
  return true;
}
