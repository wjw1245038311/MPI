import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const ti = await import("../src/renderer/src/lib/thinking-indicator.ts");

/** 最小 ThreadState 切片：默认「agent 在跑、无工具」= 应显示。 */
const base = (over = {}) => ({ isStreaming: true, compacting: false, toolRuns: {}, ...over });
const streamingMsg = { key: "a1", role: "assistant" };
const streamingWithText = { key: "a1", role: "assistant", blocks: [{ type: "text", text: "好" }] };
const streamingWithTool = { key: "a1", role: "assistant", blocks: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] };

// --- 不显示 ---------------------------------------------------------------

assert.equal(ti.shouldShowThinkingIndicator(null, null), false); // 无线程
assert.equal(ti.shouldShowThinkingIndicator({ ...base(), isStreaming: false }, null), false); // run 未开始/已结束
assert.equal(ti.shouldShowThinkingIndicator(base(), streamingWithText), false); // 已有正文 → 消息自己渲染
assert.equal(ti.shouldShowThinkingIndicator(base(), streamingWithTool), false); // 已有工具卡 → 它已展示活动
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
  ti.shouldShowThinkingIndicator(base(), streamingMsg),
  true,
); // assistant 已 start 但一个块都没有（本地模型 prefill 期间的真实状态）→ 仍然要等
assert.equal(
  ti.shouldShowThinkingIndicator({ ...base(), toolRuns: { t1: doneRun } }, null),
  true,
); // 工具全部结束 → 等待下一次 LLM 响应头（第二轮 prefill）

// --- 秒数文案 ---------------------------------------------------------------

assert.equal(ti.formatElapsed(0), "0s");
assert.equal(ti.formatElapsed(59), "59s");
assert.equal(ti.formatElapsed(60), "1m00s");
assert.equal(ti.formatElapsed(83), "1m23s");
assert.equal(ti.formatElapsed(-5), "0s"); // 时钟回拨/负值不吐怪字符串
assert.equal(ti.formatElapsed(3599), "59m59s");

// --- 等待秒数的起点：回合开始，而不是组件挂载（切会话不再归零） -----------
// maxbox 2026-10-13 录屏：切走再切回，秒数从 0 重新起算，用户误以为 prefill 白跑了。
// 根因是组件在 mount effect 里取 Date.now() 当起点；现在起点由 thread.turnStartedAt 传入。
const NOW = 1_000_000;
assert.equal(ti.thinkingElapsedSeconds(NOW - 28_000, NOW, NOW), 28); // 重挂载后仍是 28s，不是 0
assert.equal(ti.thinkingElapsedSeconds(NOW - 145_000, NOW, NOW), 145); // 冷读 37 万 token 的 145s 不被漏计
assert.equal(ti.thinkingElapsedSeconds(undefined, NOW, NOW - 3_000), 3); // 无回合时间戳 → 退化成挂载时刻
assert.equal(ti.thinkingElapsedSeconds(NaN, NOW, NOW - 2_000), 2); // 脏值同样退化成兜底
assert.equal(ti.thinkingElapsedSeconds(NOW + 5_000, NOW, NOW), 0); // 时钟回拨/负值不出负数

// --- 计时起点必须在「每段等待开始」刷新（源级护栏） -------------------------------
// 为什么是读源码而不是跑行为：reduceThread 不导出，也没有 store 的测试夹具（它依赖
// React/pi SDK）。而这两个刷新点很容易在重构中被抹掉：丢了就回到「整轮累加」这个
// 用户 2026-10-13 实测到的 bug（多段思考 + 工具调用的会话显示 1m53s）。
const storeSrc = readFileSync(new URL("../src/renderer/src/store.ts", import.meta.url), "utf8");
const branchOf = (name) => {
  const i = storeSrc.indexOf(`case "${name}":`);
  assert.ok(i >= 0, `store.ts 里找不到 case "${name}"`);
  return storeSrc.slice(i, i + 2500);
};
assert.match(branchOf("tool_execution_end"), /turnStartedAt/, "工具结束必须刷新 turnStartedAt（否则多步会话会把整轮时间累加）");
assert.match(branchOf("message_end"), /turnStartedAt/, "上一条回复结束必须刷新 turnStartedAt（多步会话同理）");
assert.match(storeSrc, /turnStartedAt:\s*sentAt/, "发送那一刻仍必须写入起点（排队/建桥/冷启动那段不能漏计）");

console.log("thinking-indicator tests passed");
