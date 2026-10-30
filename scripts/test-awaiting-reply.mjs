import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const { looksAwaitingReply } = await import("../src/renderer/src/lib/awaiting-reply.ts");

// --- 现场原句（minibox session-01a1885c，2026-10-30 00:27）-----------------
// 模型干完当轮活后以正文提问收尾：没有 choices 围栏、没有报错、会话里完全干净，
// 界面与「任务已做完」一模一样，用户 7 小时后才发现任务停在等签字。
assert.equal(looksAwaitingReply("…其中一条是新的 ready 决定（愚人节 → 目标），我没有 apply 它，等你对第 4 条的意见。"), true);

// --- 收尾问句 ---------------------------------------------------------------
assert.equal(looksAwaitingReply("这一批做完了，要不要现在就发版？"), true);
assert.equal(looksAwaitingReply("Should I go ahead with option B?"), true);
// 尾部装饰符（引号 / 括号 / 句点）不影响判定
assert.equal(looksAwaitingReply("要现在推吗？（等你确认）"), true);
assert.equal(looksAwaitingReply("下一步走 A 还是 B？ "), true);

// --- 明确的等待语 -----------------------------------------------------------
assert.equal(looksAwaitingReply("改动已提交，待你确认后我推送。"), true);
assert.equal(looksAwaitingReply("Everything is committed. Let me know if you want the push."), true);

// --- 不该提示的情形 ---------------------------------------------------------
// 正常汇报（这轮真的做完了）
assert.equal(looksAwaitingReply("已完成，测试 130 pass，已推送 origin/main。"), false);
assert.equal(looksAwaitingReply(""), false);
assert.equal(looksAwaitingReply(undefined), false);
// 已经给了可点面板 → 面板本身就是提示，不叠加
assert.equal(
  looksAwaitingReply('结论如下。\n```choices\n[{"title":"下一步","options":["A","B"]}]\n```'),
  false,
);
// 以代码块/表格收尾、且没有等待语 → 不算在等
assert.equal(looksAwaitingReply("改完了：\n```ts\nconst a = 1;\n```"), false);
assert.equal(looksAwaitingReply("| 项 | 结果 |\n|---|---|\n| 测试 | 通过 |"), false);
// 等待语只出现在长文开头（尾部 400 字窗口外）→ 不算
const longBody = `等你先看这段背景，后面全是本次的错误码与日志。\n${"x".repeat(600)}`;
assert.equal(looksAwaitingReply(longBody), false);

console.log("awaiting-reply: 13 assertions passed");
