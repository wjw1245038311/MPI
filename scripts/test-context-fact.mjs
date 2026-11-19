import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

const { buildFactText, fmt } = await import("../src/main/mpi-context-fact-ext.ts");

// ---------------------------------------------------------------------------
// 这两个数字取自 2026-11-10 两个真实会话的压缩记录（tokensBefore）与模型定义（contextWindow）
// ---------------------------------------------------------------------------
const REAL_WINDOW = 524288; // strata/qwen3.8-flash-next@ud-iq4_xs 的 models.json 值
const SESSION_A = 466211; // 会话 A（模型说「180k」那次）的 tokensBefore
const SESSION_B = 438142; // 会话 B（模型说「不足 5%」那次）的 tokensBefore

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
}

console.log("context-fact: fmt");

ok("千分位格式化", () => {
  assert.equal(fmt(524288), "524,288");
  assert.equal(fmt(466211), "466,211");
  assert.equal(fmt(0), "0");
});

console.log("\ncontext-fact: buildFactText");

ok("包含真实窗口值（而不是 168000 之类）", () => {
  const text = buildFactText(SESSION_A, REAL_WINDOW);
  assert.ok(text.includes("524,288"), "必须写明真实窗口");
  assert.ok(!text.includes("168000") && !text.includes("168,000"), "不得出现那个假值");
  assert.ok(!text.includes("180,000") && !text.includes("180000"), "不得出现模型自编的假值");
});

ok("包含压缩前占用与百分比", () => {
  const text = buildFactText(SESSION_A, REAL_WINDOW);
  assert.ok(text.includes("466,211"), "应含压缩前 tokens");
  // 466211 / 524288 ≈ 88.9%
  assert.ok(/约 89%/.test(text), `百分比应约 89%，实际文本：${text}`);
});

ok("会话 B 的数字也对", () => {
  const text = buildFactText(SESSION_B, REAL_WINDOW);
  assert.ok(text.includes("438,142"));
  assert.ok(/约 84%/.test(text), "438142/524288 ≈ 83.6% → 约 84%");
});

ok("明确要求模型不要自行估算余量", () => {
  const text = buildFactText(SESSION_A, REAL_WINDOW);
  assert.ok(text.includes("不要自行估算"), "必须明确禁止自估");
  assert.ok(text.includes("工具调用真的失败"), "必须给出收工判定口径");
});

ok("窗口未知时不瞎编百分比", () => {
  const text = buildFactText(SESSION_A, 0);
  assert.ok(!/%/.test(text), "窗口为 0 时不得输出百分比");
  assert.ok(text.includes("未声明窗口"), "应明说窗口未知");
  assert.ok(text.includes("466,211"), "但仍应给出压缩前占用");
});

ok("百分比不会超过 100%（异常 tokensBefore 的兜底）", () => {
  const text = buildFactText(999999999, REAL_WINDOW);
  // 只看实际输出的百分比数字，不用脆的正则猜
  const m = /约 (\d+)%/.exec(text);
  assert.ok(m, "应当有百分比");
  const pct = Number(m[1]);
  assert.ok(pct <= 100, `百分比不得 >100，实际 ${pct}%`);
  assert.equal(pct, 100, "超限时应夹到 100%");
});

ok("给出引擎侧真值的获取方式", () => {
  const text = buildFactText(SESSION_A, REAL_WINDOW);
  assert.ok(text.includes("strata-8090.log"), "应指引去读引擎日志");
});

console.log(`\ncontext-fact: ${pass} 项全部通过`);
