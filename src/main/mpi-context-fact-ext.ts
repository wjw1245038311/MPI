/**
 * 压缩后上下文事实 bridge：在压缩完成后，把**真实的**窗口/占用/余量告诉模型。
 *
 * 为什么需要
 * ----------
 * 2026-11-10 连续两个会话出现同一现象：模型在压缩之后开始编造上下文数字。
 *   · 会话 A：真实 260k/524k，它说「系统说 exceeds the 180000-tokens context budget」
 *   · 会话 B：真实 325,673/524,288（62%），它说「我这轮上下文真的到底了（不足 5%）」
 * 逐条核对两个会话的 jsonl：`system_context` / `Current stage` / `context used` 全部 0 命中，
 * 也就是说**系统从没给过这些数字**——是模型自己算的。
 *
 * 为什么偏偏是压缩之后：pi 在压缩后会让 `getSessionStats().contextUsage` 返回
 * `{ tokens: null, percent: null }`（agent-session.js 里 hasPostCompactionUsage 分支），
 * 直到下一次回复才有新 usage。于是模型刚丢完全部历史、又看不到任何余量，处在一个
 * 「信息真空」里，只能自己估——估出来的就是这个 180k / 5%。
 *
 * 为什么不改 pi：压缩后的 null 是 pi 的有意设计（避免把压缩前的 usage 当现值）。
 * 修法不该动那个判断，而是**在压缩完成时补一条准确的事实**，让模型有个可依据的数。
 *
 * 本扩展只在压缩后注入一条 display:false 的系统事实消息（不进界面对话流），
 * 数据全部来自 pi 自己算好的 compaction 结果 + 当前模型定义，不另行估算窗口。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 这几种压缩都由本扩展补充事实；自动压缩同样需要（它也会造成同样的真空）。 */
interface CompactionEntryLike {
  type?: string;
  tokensBefore?: number;
}

interface SessionCompactEvent {
  type?: string;
  reason?: string;
  compactionEntry?: CompactionEntryLike;
}

/** 注入消息的自定义类型，便于会话文件里一眼认出来源。 */
const CUSTOM_TYPE = "mpi-context-fact";

/** 把数字格式化成 "524,288" 这种人能读、模型也容易抓的形式。 */
export function fmt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/**
 * 组一句给模型看的上下文事实。
 *
 * 刻意写成陈述句而不是警告句：模型对「⚠️ 警告」这类措辞会过度反应（实测会据此提前收工），
 * 对「事实 + 请以本值为准」的接受度更好。
 */
export function buildFactText(tokensBefore: number, contextWindow: number): string {
  if (!(contextWindow > 0)) {
    return `[系统事实] 刚才发生过一次上下文压缩（压缩前约 ${fmt(tokensBefore)} tokens）。本会话模型未声明窗口大小，请不要自行推算上下文余量；是否该收工只以「系统宣布已压缩」或「工具调用真的失败」为准。`;
  }
  // 压缩后的真实占用由 pi 在新的 usage 到来前无法给出，但「窗口」是确定的，
  // 而模型真正缺的是「上限是多少、我压完还剩多少」这两个数。
  const usedPct = Math.min(100, (tokensBefore / contextWindow) * 100);
  return [
    `[系统事实] 刚才发生过一次上下文压缩。`,
    `本会话上下文窗口 = ${fmt(contextWindow)} tokens；压缩前占用 = ${fmt(tokensBefore)} tokens（约 ${usedPct.toFixed(0)}%）。`,
    `压缩后历史已被摘要替换，当前实际占用会显著低于压缩前。`,
    `请不要自行估算上下文余量，也不要因为「快到上限了」而提前停止任务——`,
    `是否该收工只以「系统明确宣布已压缩」或「工具调用真的失败」为准。`,
    `如需精确值，可运行：grep "prompt .* tokens" F:/Strata-0.2.7/strata-8090.log | tail -5（引擎侧真值）。`,
  ].join("\n");
}

export default function mpiContextFact(pi: ExtensionAPI): void {
  pi.on("session_compact", async (event: unknown, ctx: unknown) => {
    try {
      const payload = (event ?? {}) as SessionCompactEvent;
      const tokensBefore = Number(payload.compactionEntry?.tokensBefore ?? 0);
      if (!Number.isFinite(tokensBefore) || tokensBefore <= 0) return;

      const context = (ctx ?? {}) as {
        model?: { contextWindow?: number };
        sendMessage?: (message: unknown, options?: unknown) => Promise<void> | void;
      };
      if (typeof context.sendMessage !== "function") return;

      const contextWindow = Number(context.model?.contextWindow ?? 0);
      await context.sendMessage(
        {
          customType: CUSTOM_TYPE,
          // display:false —— 这条是给模型的事实，不需要占用用户的对话流。
          display: false,
          content: [{ type: "text", text: buildFactText(tokensBefore, contextWindow) }],
        },
        // 不触发新的一轮：压缩后用户通常会继续原来的话题，
        // 这条消息挂在那里，下一次模型请求自然会读到。
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
    } catch {
      // 上下文事实是锦上添花：模型注册表不可用、压缩事件形状变了、
      // 或者 sendMessage 被拒绝——任何异常都不能让压缩本身失败。
      return;
    }
  });
}
