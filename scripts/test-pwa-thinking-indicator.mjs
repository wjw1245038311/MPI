// prefill「思考中 · Ns」指示器谓词（PWA 版）：与桌面端 test-thinking-indicator.mjs、
// Android ThinkingIndicatorTest 同一套语义——三端判据必须一致，否则同一个本地模型
// prefill 窗口在某个端看着像卡死。
import assert from "node:assert/strict";

const ti = await import("../mobile/pwa/src/lib/thinking-indicator.ts");

/** 最小视图切片：默认「agent 在跑、无工具」= 应显示。 */
const base = (over = {}) => ({ running: true, compacting: false, messages: [], streaming: null, ...over });
const emptyStreaming = { blocks: [] }; // message_start 已到但一个块都没有（本地模型 prefill 的真实状态）
const withText = { blocks: [{ type: "text", text: "好" }] };
const withThinking = { blocks: [{ type: "thinking", text: "让我想想…" }] };
const withToolBlock = { blocks: [{ type: "tool", name: "bash" }] };
const withImage = { blocks: [{ type: "image", data: "AAAA" }] };

// --- 不显示 ---------------------------------------------------------------

assert.equal(ti.shouldShowThinkingIndicator(null), false); // 无视图
assert.equal(ti.shouldShowThinkingIndicator(base({ running: false })), false); // 回合未开始/已结束
assert.equal(ti.shouldShowThinkingIndicator(base({ streaming: withText })), false); // 已有正文 → 消息自己渲染
assert.equal(
  ti.shouldShowThinkingIndicator(base({ streaming: withThinking })),
  false,
); // 已有思考内容 → 可见活动
assert.equal(ti.shouldShowThinkingIndicator(base({ streaming: withToolBlock })), false); // 工具卡已展示活动
assert.equal(ti.shouldShowThinkingIndicator(base({ streaming: withImage })), false); // 图片也是可见内容
assert.equal(
  ti.shouldShowThinkingIndicator(base({ compacting: true })),
  false,
); // 压缩进行中 → composer/上下文 chip 侧指示器接管

// --- 工具卡状态（历史消息里也有 running 工具时同样抑制） ---------------------

const doneTool = { blocks: [{ type: "tool", name: "read", running: false }] };
const runningTool = { blocks: [{ type: "tool", name: "bash", running: true }] };

assert.equal(
  ti.shouldShowThinkingIndicator(base({ messages: [runningTool] })),
  false,
); // 有工具在跑 → 不叠加占位行
assert.equal(
  ti.shouldShowThinkingIndicator(base({ messages: [doneTool, runningTool] })),
  false,
); // 多个消息只要有一个工具在跑就抑制
assert.equal(
  ti.shouldShowThinkingIndicator(base({ messages: [doneTool], streaming: emptyStreaming })),
  true,
); // 工具全部结束 + 流式消息还是空的 → 等下一轮 prefill，要显示

// --- 显示（三个 prefill 窗口） ---------------------------------------------

assert.equal(ti.shouldShowThinkingIndicator(base()), true); // 发送后 → agent_start / LLM prefill
assert.equal(
  ti.shouldShowThinkingIndicator(base({ streaming: emptyStreaming })),
  true,
); // assistant 已 start 但一个块都没有（响应头早于 prefill 完成）→ 仍然要等
assert.equal(
  ti.shouldShowThinkingIndicator(base({ messages: [doneTool] })),
  true,
); // 工具全部结束 → 等待下一次 LLM 响应头（第二轮 prefill）

// --- 秒数文案（与桌面端 formatElapsed 逐条对齐） -----------------------------

assert.equal(ti.formatElapsed(0), "0s");
assert.equal(ti.formatElapsed(59), "59s");
assert.equal(ti.formatElapsed(60), "1m00s");
assert.equal(ti.formatElapsed(83), "1m23s");
assert.equal(ti.formatElapsed(-5), "0s"); // 时钟回拨/负值不吐怪字符串
assert.equal(ti.formatElapsed(3599), "59m59s");

console.log("test-pwa-thinking-indicator: all checks passed");
