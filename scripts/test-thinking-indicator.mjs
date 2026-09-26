import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const ti = await import("../src/renderer/src/lib/thinking-indicator.ts");

/** 最小 ThreadState 切片：默认「agent 在跑、无工具」= 应显示。 */
const base = (over = {}) => ({ isStreaming: true, compacting: false, toolRuns: {}, ...over });
const streamingMsg = { key: "a1", role: "assistant" };

// --- 不显示 ---------------------------------------------------------------

assert.equal(ti.shouldShowThinkingIndicator(null, null), false); // 无线程
assert.equal(ti.shouldShowThinkingIndicator({ ...base(), isStreaming: false }, null), false); // run 未开始/已结束
assert.equal(ti.shouldShowThinkingIndicator(base(), streamingMsg), false); // assistant 消息已开始 → 消息内「思考中」接管
assert.equal(
  ti.shouldShowThinkingIndicator({ ...base(), compacting: true }, null),
  false,
); // 压缩进行中 → composer 侧指示器接管

// --- 工具卡状态 -------------------------------------------------------------

const runningRun = { id: "t1", name: "bash", running: true };
const doneRun = { id: "t2", name: "read", running: false, completed: true };

assert.equal(
  ti.shouldShowThinkingIndicator({ ...base(), toolRuns: { t1: runningRun } }, null),
  false,
); // 有工具在跑 → 工具卡已展示活动，不叠加占位行
assert.equal(
  ti.shouldShowThinkingIndicator({ ...base(), toolRuns: { t1: doneRun, t2: runningRun } }, null),
  false,
); // 多个工具只要有一个在跑就抑制

// --- 显示（三个 prefill 窗口） ---------------------------------------------

assert.equal(ti.shouldShowThinkingIndicator(base(), null), true); // 发送后 → agent_start / LLM prefill
assert.equal(
  ti.shouldShowThinkingIndicator({ ...base(), toolRuns: { t1: doneRun } }, null),
  true,
); // 工具全部结束 → 等待下一次 LLM 响应头（第二轮 prefill）

console.log("thinking-indicator tests passed");
