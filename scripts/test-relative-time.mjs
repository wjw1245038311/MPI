/**
 * 会话列表时间口径（src/renderer/src/lib/relative-time.ts）。
 *
 * 背景：会话行以前只给 `MM/DD HH:mm`，昨天的会话和今天的会话长得一样，
 * 用户在多条会话间容易点错（2026-10-18 反馈）。这里钉住三件事：
 *   1. 四个自然日桶的边界（今天 / 昨天 / 本周 / 更早），特别是「周一那天周日必须算昨天」
 *   2. 行内时间的文案（一小时以内给相对时间，更早必须带日期）
 *   3. 跨年必须带年份
 */
import assert from "node:assert/strict";

const { dayBucket, bucketLabel, sessionTimeLabel } = await import("../src/renderer/src/lib/relative-time.ts");

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ✓ ${m}`);
};
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

// --- 1. 桶边界（now = 2026-10-18 周日 12:00）------------------------------------
const sunday = at(2026, 10, 18, 12);
assert.equal(dayBucket(at(2026, 10, 18, 9, 30), sunday), "today", "同一天上午 → today");
assert.equal(dayBucket(at(2026, 10, 18, 0, 0), sunday), "today", "当天 00:00 仍算今天");
assert.equal(dayBucket(at(2026, 10, 17, 23, 59), sunday), "yesterday", "昨天 23:59 → yesterday");
assert.equal(dayBucket(at(2026, 10, 14), sunday), "this-week", "本周三 → this-week");
assert.equal(dayBucket(at(2026, 10, 12), sunday), "this-week", "本周一 → this-week（边界含）");
assert.equal(dayBucket(at(2026, 10, 11), sunday), "earlier", "上周日 → earlier");
assert.equal(dayBucket(at(2025, 12, 31), sunday), "earlier", "去年 → earlier");
ok("today / yesterday / this-week / earlier 四个桶边界正确");

// 周一那天：昨天是周日，必须优先于「本周」判断（否则会被算成本周）
const monday = at(2026, 10, 19, 10);
assert.equal(dayBucket(at(2026, 10, 18, 20), monday), "yesterday", "周一视角下周日是昨天，不是本周");
assert.equal(dayBucket(at(2026, 10, 17, 20), monday), "earlier", "周一视角下周六属上周 → earlier");
assert.equal(dayBucket(at(2026, 10, 19, 9), monday), "today", "周一当天 → today");
ok("周一视角下「昨天」优先于「本周」");

// 坏时间戳不崩、归入 earlier
assert.equal(dayBucket(NaN, sunday), "earlier", "NaN → earlier");
ok("坏时间戳安全降级");

// --- 2. 标签 --------------------------------------------------------------------
assert.equal(bucketLabel("today", true), "今天");
assert.equal(bucketLabel("yesterday", true), "昨天");
assert.equal(bucketLabel("this-week", true), "本周");
assert.equal(bucketLabel("earlier", true), "更早");
assert.equal(bucketLabel("today", false), "Today");
assert.equal(bucketLabel("earlier", false), "Earlier");
ok("分组标题中英文正确");

// --- 3. 行内时间 ----------------------------------------------------------------
assert.equal(sessionTimeLabel(sunday - 30_000, true, sunday), "刚刚", "30 秒前 → 刚刚");
assert.equal(sessionTimeLabel(sunday - 20 * 60_000, true, sunday), "20 分钟前", "20 分钟前 → 相对时间");
assert.equal(sessionTimeLabel(sunday - 59 * 60_000, true, sunday), "59 分钟前", "59 分钟内仍是相对时间");
assert.equal(sessionTimeLabel(at(2026, 10, 18, 9, 30), true, sunday), "今天 09:30", "超过 1 小时且是今天 → 今天 HH:mm");
assert.equal(sessionTimeLabel(at(2026, 10, 17, 20, 15), true, sunday), "昨天 20:15", "昨天必须带「昨天」");
assert.equal(sessionTimeLabel(at(2026, 10, 14, 14, 2), true, sunday), "周三 14:02", "本周给周几");
assert.equal(sessionTimeLabel(at(2026, 10, 1, 8, 0), true, sunday), "10-01 08:00", "更早给月-日");
assert.equal(sessionTimeLabel(at(2025, 12, 31, 9, 0), true, sunday), "2025-12-31 09:00", "跨年必须带年份");
assert.equal(sessionTimeLabel(at(2025, 12, 31, 9, 0), false, sunday), "2025-12-31 09:00", "英文跨年同样带年份");
ok("行内时间：一小时内相对，更早带日期，跨年带年份");

console.log(`\nrelative-time 测试通过：${n} 项`);
