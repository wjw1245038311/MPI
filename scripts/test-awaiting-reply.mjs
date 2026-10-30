import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const desktop = await import("../src/renderer/src/lib/awaiting-reply.ts");
const pwa = await import("../mobile/pwa/src/lib/awaiting-reply.ts");

/**
 * 「等你回复」提示的判定（三端同一判据）。
 *
 * 桌面 `src/renderer/src/lib/awaiting-reply.ts`、PWA `mobile/pwa/src/lib/awaiting-reply.ts`、
 * Android `ui/AwaitingReplyLogic.kt` 各一份实现（Kotlin 那份由
 * `mobile/app/.../AwaitingReplyLogicTest.kt` 覆盖同样用例）。这里对前两份做
 * **parity 断言**：同一组输入两边结论必须一致，防止改了一边忘了另一边。
 */
const CASES = [
  // 现场原句（minibox session-01a1885c，2026-10-30 00:27）：模型以正文提问收尾，
  // 会话文件干净（stopReason=stop），界面却与「任务做完」一模一样。
  [
    "…其中一条是新的 ready 决定（愚人节 → 目标），我没有 apply 它，等你对第 4 条的意见。",
    true,
  ],
  // 收尾问句
  ["这一批做完了，要不要现在就发版？", true],
  ["Should I go ahead with option B?", true],
  ["要现在推吗？（等你确认）", true],
  ["下一步走 A 还是 B？ ", true],
  // 明确的等待语
  ["改动已提交，待你确认后我推送。", true],
  ["Everything is committed. Let me know if you want the push.", true],
  // 不该提示
  ["已完成，测试 130 pass，已推送 origin/main。", false],
  ["", false],
  ["改完了：\n```ts\nconst a = 1;\n```", false],
  ["| 项 | 结果 |\n|---|---|\n| 测试 | 通过 |", false],
  // 已经给了可点面板 → 面板本身就是提示，不叠加
  ['结论如下。\n```choices\n[{"title":"下一步","options":["A","B"]}]\n```', false],
  // 等待语只在长文开头（尾部 400 字窗口外）→ 不算
  [`等你先看这段背景，后面全是本次的错误码与日志。\n${"x".repeat(600)}`, false],
];

for (const [text, expected] of CASES) {
  const label = JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);
  assert.equal(desktop.looksAwaitingReply(text), expected, `桌面判定不符：${label}`);
  assert.equal(pwa.looksAwaitingReply(text), expected, `PWA 判定不符：${label}`);
  assert.equal(
    desktop.looksAwaitingReply(text),
    pwa.looksAwaitingReply(text),
    `三端判据漂移（桌面 vs PWA）：${label}`,
  );
}

// undefined 输入（调用方可能直接传 message.text，理论上有 undefined 的旧数据）
assert.equal(desktop.looksAwaitingReply(undefined), false);
assert.equal(pwa.looksAwaitingReply(undefined), false);

console.log(`awaiting-reply: ${CASES.length} cases × 2 端 + parity 全部通过`);
