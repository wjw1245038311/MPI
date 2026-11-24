/**
 * Equivalence test: mobile/pwa/src/lib/relative-time.ts (PWA vendored copy)
 * must behave identically to src/renderer/src/lib/relative-time.ts (desktop source).
 *
 * 与 scripts/test-pwa-shared.mjs 同一套路：两份构建互不 import，靠这个测试防漂移。
 * 时间相关的口径一旦分叉，桌面端显示「昨天」而手机显示「更早」这类问题不会被任何
 * 一端自己的测试发现（test-relative-time.mjs 只测渲染层那份）。
 */
import assert from "node:assert/strict";

const desktop = await import("../src/renderer/src/lib/relative-time.ts");
const pwa = await import("../mobile/pwa/src/lib/relative-time.ts");

// 固定 now，避免跨毫秒/跨分钟的抖动；取一个周三下午，保证四个桶都有样本。
const NOW = new Date(2026, 10, 25, 15, 30, 0).getTime(); // 2026-11-25 周三 15:30 本地
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// 覆盖四个桶 + 边界：分钟/小时阈值、今天 00:00、昨天最后一刻、本周一 00:00、跨年
const now = new Date(2026, 10, 25, 15, 30, 0).getTime();
const samples = [
  now,
  now - 30 * 1000,
  now - MIN,
  now - 61_000,
  now - 59 * MIN,
  now - HOUR,
  now - 3 * HOUR,
  now - 23 * HOUR - 59 * MIN,
  // 今天 00:00:00（应仍算 today）
  new Date(2026, 10, 25, 0, 0, 0).getTime(),
  // 昨天 23:59（yesterday 优先于 this-week）
  new Date(2026, 10, 24, 23, 59, 59).getTime(),
  new Date(2026, 10, 24, 0, 0, 0).getTime(),
  // 本周一 00:00（2026-11-23 是周一，应算 this-week）
  new Date(2026, 10, 23, 0, 0, 0).getTime(),
  new Date(2026, 10, 22, 23, 59, 0).getTime(), // 上周日 → earlier
  new Date(2026, 10, 15, 9, 0, 0).getTime(),
  new Date(2026, 1, 1, 0, 0, 0).getTime(),
  // 跨年（去年 12-31 必须带年份）
  new Date(2025, 11, 31, 23, 59, 0).getTime(),
  new Date(2025, 11, 31, 9, 0, 0).getTime(),
  // 非未来时间之外：未来 1 分钟（防御性）
  now + MIN,
  // 非法输入
  Number.NaN,
  undefined,
  null,
  0,
];

let checked = 0;
for (const ts of samples) {
  for (const zh of [true, false]) {
    const a = desktopBucket(ts, zh);
    const b = pwaBucket(ts, zh);
    assert.deepEqual(b, a, `dayBucket/bucketLabel(${ts}, zh=${zh})`);
    const ta = desktopTime(ts, zh);
    const tb = pwaTime(ts, zh);
    assert.deepEqual(tb, ta, `sessionTimeLabel(${ts}, zh=${zh})`);
    checked += 2;
  }
}
console.log(`✓ relative-time 两份实现在 ${checked} 项断言上逐字一致`);

function desktopBucket(ts, zh) {
  return desktop.bucketLabel(desktop.dayBucket(ts, now), zh);
}
function pwaBucket(ts, zh) {
  return pwa.bucketLabel(pwa.dayBucket(ts, now), zh);
}
function desktopTime(ts, zh) {
  return desktop.sessionTimeLabel(ts, zh, now);
}
function pwaTime(ts, zh) {
  return pwa.sessionTimeLabel(ts, zh, now);
}

// --- 分组标题的插入位置：只在桶变化处出一个标题 -------------------------------
const ordered = [
  { updatedAt: now - MIN },
  { updatedAt: now - 2 * HOUR },
  { updatedAt: now - DAY }, // 昨天 → 应插标题
  { updatedAt: now - DAY - HOUR },
  { updatedAt: now - 5 * DAY }, // 更早 → 应插标题
];
const expected = ["今天", null, "昨天", null, "更早"];
const got = ordered.map((item, i) => pwa.groupLabelAt(ordered, i, now, true));
assert.deepEqual(got, expected, "groupLabelAt 插标题位置");
console.log(`✓ groupLabelAt 只在自然日变化处插标题（${expected.filter(Boolean).length} 个标题）`);
