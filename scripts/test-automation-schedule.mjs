// 调度纯函数单测（automation-schedule.ts）。
//
// 背景：旧实现用 `HH:MM` 等值比较判定「到点」，只认那 60 秒窗口——主进程
// 定时器在睡眠期间不补发，醒来即错过；`slotKey()` 又按日历天去重，导致
// 把 09:00 改成 14:00 后当天不再触发。这里把两类回归都固化成断言。
import assert from "node:assert/strict";
import {
  DEFAULT_CATCH_UP_MINUTES,
  decideDueSlot,
  describeSchedule,
  latestSlotBetween,
  nextRunAfter,
  nextTickDelay,
  parseTimeOfDay,
  slotId,
  slotsBetween,
} from "../src/main/automation-schedule.ts";

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
let checks = 0;
const ok = (label) => {
  checks++;
  return label;
};

// ---- parseTimeOfDay -------------------------------------------------------
assert.deepEqual(parseTimeOfDay("09:30"), { hour: 9, minute: 30 }, ok("合法时刻"));
assert.deepEqual(parseTimeOfDay("9:05"), { hour: 9, minute: 5 }, ok("单位数小时"));
assert.equal(parseTimeOfDay("25:00"), null, ok("小时越界必须是 null，不能落成 00:00"));
assert.equal(parseTimeOfDay("09:60"), null, ok("分钟越界"));
assert.equal(parseTimeOfDay("9.30"), null, ok("分隔符错误"));
assert.equal(parseTimeOfDay(undefined), null, ok("缺值"));

// ---- slotId ---------------------------------------------------------------
assert.equal(slotId(at(2026, 11, 26, 9, 5)), "2026-11-26T09:05", ok("槽位 id 精确到分钟"));
assert.notEqual(slotId(at(2026, 11, 26, 9, 0)), slotId(at(2026, 11, 26, 14, 0)), ok("同一天不同时刻是不同槽位"));

// ---- nextRunAfter: daily --------------------------------------------------
const daily = { frequency: "daily", time: "09:00" };
assert.deepEqual(nextRunAfter(daily, at(2026, 11, 26, 8, 0)), at(2026, 11, 26, 9, 0), ok("daily: 当天未到"));
assert.deepEqual(nextRunAfter(daily, at(2026, 11, 26, 9, 0)), at(2026, 11, 27, 9, 0), ok("daily: 恰好等于则跳下一天"));
assert.deepEqual(nextRunAfter(daily, at(2026, 11, 26, 9, 1)), at(2026, 11, 27, 9, 0), ok("daily: 已过则下一天"));
assert.deepEqual(nextRunAfter(daily, at(2026, 12, 31, 23, 59)), at(2027, 1, 1, 9, 0), ok("daily: 跨年"));
assert.deepEqual(nextRunAfter({ frequency: "daily", time: "00:00" }, at(2026, 11, 26, 23, 59)), at(2026, 11, 27, 0, 0), ok("daily: 午夜边界"));

// 闰日：2028 是闰年
assert.deepEqual(nextRunAfter({ frequency: "daily", time: "09:00" }, at(2028, 2, 28, 10, 0)), at(2028, 2, 29, 9, 0), ok("daily: 闰年 2/29"));
assert.deepEqual(nextRunAfter({ frequency: "daily", time: "09:00" }, at(2027, 2, 28, 10, 0)), at(2027, 3, 1, 9, 0), ok("daily: 平年跳过 2/29"));

// ---- nextRunAfter: weekly -------------------------------------------------
const weeklyMon = { frequency: "weekly", time: "05:00", days: [1] };
assert.deepEqual(nextRunAfter(weeklyMon, at(2026, 11, 26, 12, 0)), at(2026, 11, 30, 5, 0), ok("weekly: 周四 → 下周一"));
assert.deepEqual(nextRunAfter(weeklyMon, at(2026, 11, 30, 4, 0)), at(2026, 11, 30, 5, 0), ok("weekly: 当天未到"));
assert.deepEqual(nextRunAfter(weeklyMon, at(2026, 11, 30, 5, 0)), at(2026, 12, 7, 5, 0), ok("weekly: 恰好等于则下一周"));
assert.deepEqual(nextRunAfter(weeklyMon, at(2026, 12, 31, 23, 0)), at(2027, 1, 4, 5, 0), ok("weekly: 跨年"));
// 多天：周一+周五
const weeklyMonFri = { frequency: "weekly", time: "05:00", days: [1, 5] };
assert.deepEqual(nextRunAfter(weeklyMonFri, at(2026, 11, 27, 12, 0)), at(2026, 11, 30, 5, 0), ok("weekly: 周五已过 → 周一"));
assert.deepEqual(nextRunAfter(weeklyMonFri, at(2026, 11, 30, 5, 1)), at(2026, 12, 4, 5, 0), ok("weekly: 周一到下一个周五"));
// 周日 = 0（不是 7）
assert.deepEqual(nextRunAfter({ frequency: "weekly", time: "08:00", days: [0] }, at(2026, 11, 26, 0, 0)), at(2026, 11, 29, 8, 0), ok("weekly: 0 = 周日"));
// days 为空 → 不触发
assert.equal(nextRunAfter({ frequency: "weekly", time: "08:00", days: [] }, at(2026, 11, 26, 0, 0)), null, ok("weekly: days 为空返回 null"));

// ---- nextRunAfter: hourly -------------------------------------------------
const hourly = { frequency: "hourly", minute: 20 };
assert.deepEqual(nextRunAfter(hourly, at(2026, 11, 26, 9, 5)), at(2026, 11, 26, 9, 20), ok("hourly: 本小时未到"));
assert.deepEqual(nextRunAfter(hourly, at(2026, 11, 26, 9, 20)), at(2026, 11, 26, 10, 20), ok("hourly: 恰好等于则下一小时"));
assert.deepEqual(nextRunAfter(hourly, at(2026, 11, 26, 23, 30)), at(2026, 11, 27, 0, 20), ok("hourly: 跨天"));
assert.equal(nextRunAfter({ frequency: "hourly", minute: 99 }, at(2026, 11, 26, 9, 0)), null, ok("hourly: 分钟越界"));

// ---- 非法调度 -------------------------------------------------------------
assert.equal(nextRunAfter({ frequency: "daily" }, at(2026, 11, 26, 9, 0)), null, ok("daily 缺 time → null"));
assert.equal(nextRunAfter({ frequency: "daily", time: "25:00" }, at(2026, 11, 26, 9, 0)), null, ok("daily 非法 time → null"));

// ---- slotsBetween / latestSlotBetween ------------------------------------
const span = slotsBetween(daily, at(2026, 11, 24, 12, 0), at(2026, 11, 26, 12, 0));
assert.equal(span.length, 2, ok("区间内两个 daily 槽位"));
assert.deepEqual(span[0], at(2026, 11, 25, 9, 0), ok("区间首个槽位"));
assert.deepEqual(latestSlotBetween(daily, at(2026, 11, 24, 12, 0), at(2026, 11, 26, 12, 0)), at(2026, 11, 26, 9, 0), ok("最近槽位"));
// 上限安全阀：长时间休眠不能无限枚举
const huge = slotsBetween({ frequency: "hourly", minute: 0 }, at(2020, 1, 1, 0, 0), at(2026, 11, 26, 0, 0));
assert.equal(huge.length, 500, ok("slotsBetween 受 limit 约束"));

// ---- decideDueSlot -------------------------------------------------------

// 正常到点（窗口内）
let d = decideDueSlot({
  schedule: daily,
  lastSlot: at(2026, 11, 25, 9, 0),
  firstSeenAt: null,
  now: at(2026, 11, 26, 9, 0),
  catchUpMinutes: DEFAULT_CATCH_UP_MINUTES,
});
assert.equal(d.kind, "run", ok("到点判定：窗口内执行"));
assert.deepEqual(d.slot, at(2026, 11, 26, 9, 0), ok("执行槽位正确"));
assert.equal(d.missedCount, 0, ok("无合并"));

// 睡眠 5 分钟后醒来：旧实现在 09:05 已不匹配 HH:MM，会整天空过
d = decideDueSlot({
  schedule: daily,
  lastSlot: at(2026, 11, 25, 9, 0),
  firstSeenAt: null,
  now: at(2026, 11, 26, 9, 5),
  catchUpMinutes: DEFAULT_CATCH_UP_MINUTES,
});
assert.equal(d.kind, "run", ok("错过 5 分钟仍然补跑（旧实现回归点）"));
assert.deepEqual(d.slot, at(2026, 11, 26, 9, 0), ok("补跑槽位仍是计划时刻，不是现在"));

// 窗口边界：恰好等于窗口 → 仍然补跑
d = decideDueSlot({
  schedule: daily,
  lastSlot: at(2026, 11, 25, 9, 0),
  firstSeenAt: null,
  now: at(2026, 11, 26, 11, 0),
  catchUpMinutes: 120,
});
assert.equal(d.kind, "run", ok("恰好等于补跑窗口仍执行（闭区间）"));

// 超窗口 → 只记错过
d = decideDueSlot({
  schedule: daily,
  lastSlot: at(2026, 11, 25, 9, 0),
  firstSeenAt: null,
  now: at(2026, 11, 26, 11, 1),
  catchUpMinutes: 120,
});
assert.equal(d.kind, "missed", ok("超窗口只记错过"));
assert.deepEqual(d.slot, at(2026, 11, 26, 9, 0), ok("错过记录的是计划时刻"));

// 关闭补跑：只有恰好当分钟才执行
d = decideDueSlot({
  schedule: daily,
  lastSlot: at(2026, 11, 25, 9, 0),
  firstSeenAt: null,
  now: at(2026, 11, 26, 9, 0),
  catchUpMinutes: 0,
});
assert.equal(d.kind, "run", ok("catchUp=0 恰好当分钟仍执行"));
d = decideDueSlot({
  schedule: daily,
  lastSlot: at(2026, 11, 25, 9, 0),
  firstSeenAt: null,
  now: at(2026, 11, 26, 9, 1),
  catchUpMinutes: 0,
});
assert.equal(d.kind, "missed", ok("catchUp=0 过一分钟即错过"));

// 休眠一夜：多个槽位合并成一次运行
d = decideDueSlot({
  schedule: { frequency: "hourly", minute: 0 },
  lastSlot: at(2026, 11, 25, 22, 0),
  firstSeenAt: null,
  now: at(2026, 11, 26, 7, 30),
  catchUpMinutes: 120,
});
assert.equal(d.kind, "run", ok("多槽位仍执行一次"));
assert.equal(d.missedCount, 8, ok("被合并的槽位数 = 8（23:00…07:00 共 9 个槽位，取最近一个执行）"));
assert.deepEqual(d.slot, at(2026, 11, 26, 7, 0), ok("合并后执行最近的那个槽位"));

// 从未处理过槽位：以 firstSeenAt 为基准，而不是把历史全部补一遍
d = decideDueSlot({
  schedule: daily,
  lastSlot: null,
  firstSeenAt: at(2026, 11, 26, 8, 0),
  now: at(2026, 11, 26, 8, 30),
  catchUpMinutes: 120,
});
assert.equal(d.kind, "none", ok("首次见到且当天时刻未到 → 不执行"));
d = decideDueSlot({
  schedule: daily,
  lastSlot: null,
  firstSeenAt: at(2026, 11, 26, 8, 0),
  now: at(2026, 11, 26, 9, 10),
  catchUpMinutes: 120,
});
assert.equal(d.kind, "run", ok("首次见到后过了时刻 → 补一次"));
assert.deepEqual(d.slot, at(2026, 11, 26, 9, 0), ok("首次见到场景的槽位"));

// 没有基准 → 什么都不做（不会凭空触发）
d = decideDueSlot({ schedule: daily, lastSlot: null, firstSeenAt: null, now: at(2026, 11, 26, 9, 30), catchUpMinutes: 120 });
assert.equal(d.kind, "none", ok("无基准不触发"));

// 改时间后当天仍会触发（旧 slotKey 按日历天去重的回归点）
// 09:00 已跑（lastSlot=09:00），用户改成 14:00，14:00 时应当触发。
d = decideDueSlot({
  schedule: { frequency: "daily", time: "14:00" },
  lastSlot: at(2026, 11, 26, 9, 0),
  firstSeenAt: null,
  now: at(2026, 11, 26, 14, 0),
  catchUpMinutes: 120,
});
assert.equal(d.kind, "run", ok("改时间后当天仍触发（旧实现回归点）"));
assert.deepEqual(d.slot, at(2026, 11, 26, 14, 0), ok("改时间后的槽位"));

// 改成更早的时刻：基准是 09:00，而 07:00 已经过去了 → 今天的这次不再触发，
// 下一个槽位是明天 07:00，因此当前什么都不做（不会把已过去的今天补一遍）。
d = decideDueSlot({
  schedule: { frequency: "daily", time: "07:00" },
  lastSlot: at(2026, 11, 26, 9, 0),
  firstSeenAt: null,
  now: at(2026, 11, 26, 14, 0),
  catchUpMinutes: 120,
});
assert.equal(d.kind, "none", ok("改成更早时刻 → 今天不再跑，等下一个周期"));

// lastSlot 超前于 now（时钟回拨）：不触发
d = decideDueSlot({
  schedule: daily,
  lastSlot: at(2026, 11, 27, 9, 0),
  firstSeenAt: null,
  now: at(2026, 11, 26, 9, 30),
  catchUpMinutes: 120,
});
assert.equal(d.kind, "none", ok("时钟回拨不重复触发"));

// ---- describeSchedule ----------------------------------------------------
assert.equal(describeSchedule(daily, "zh"), "每天 09:00", ok("描述：中文 daily"));
assert.equal(describeSchedule(daily, "en"), "Daily at 09:00", ok("描述：英文 daily"));
assert.equal(describeSchedule(hourly, "zh"), "每小时 第 20 分钟", ok("描述：中文 hourly"));
assert.equal(describeSchedule(hourly, "en"), "Hourly at minute 20", ok("描述：英文 hourly"));
assert.equal(describeSchedule(weeklyMon, "zh"), "每周 一 05:00", ok("描述：中文 weekly"));
assert.equal(describeSchedule(weeklyMon, "en"), "Weekly on Mon at 05:00", ok("描述：英文 weekly"));
assert.equal(describeSchedule(weeklyMonFri, "en"), "Weekly on Mon, Fri at 05:00", ok("描述：英文多天"));
assert.equal(describeSchedule({ frequency: "weekly", time: "05:00", days: [] }, "zh"), "每周 — 05:00", ok("描述：无星期占位"));

// ---- nextTickDelay（调度器链式定时）------------------------------------
// 背景：2026-11-26 实测发现调度器只 tick 一次就停摆——`scheduleNextTick()`
// 首行用 `if (!timer) return` 做启动校卫，而 boot 阶段 timer 还是 null，
// 链式调度在第一步就断了。这个函数把「该等多久」抽出来，让这部分可被断言。
const delayOf = (enabled, schedule, now, max = 5 * 60_000, pending = false) =>
  nextTickDelay([{ enabled, schedule, pending }], now, max, (s, at2) => nextRunAfter(s, at2));

assert.equal(delayOf(true, daily, at(2026, 11, 26, 8, 0)), 300_000, ok("距 09:00 还有 1 小时 → 被 5 分钟兜底上限截断（每 5 分钟校一次）"));
assert.equal(delayOf(true, daily, at(2026, 11, 26, 8, 55)), 300_000, ok("距 09:00 还有 5 分钟 → 等于上限，300s"));
assert.equal(delayOf(true, daily, at(2026, 11, 26, 8, 56)), 241_000, ok("距 09:00 还有 4 分钟 → 精确到 241s（含 1s 偏移）"));
assert.equal(delayOf(true, daily, at(2026, 11, 26, 8, 59), 3_601_000), 61_000, ok("距 09:00 还有 1 分钟 → 61s"));
assert.equal(delayOf(true, daily, at(2026, 11, 26, 8, 0), 20_000), 20_000, ok("maxDelay 较小时被截断"));
assert.equal(delayOf(true, daily, at(2026, 11, 26, 8, 0), 500, true), 0, ok("pending（有被跳过的槽位）→ 立即 tick"));
assert.equal(delayOf(false, daily, at(2026, 11, 26, 8, 0), 500, true), 500, ok("停用任务的 pending 不算"));
// 注意：`nextRunAfter` 是「严格晚于」，所以恰好落在槽位那一刻时它给的是下一个
// 槽位（明天）。真正让那一刻立即 tick 的是 pending 标记——因为该槽位此时
// 「已到点但未处理」，decideDueSlot 会返回 run。下面把这个组合关系钉住。
assert.equal(delayOf(true, daily, at(2026, 11, 26, 9, 0)), 300_000, ok("恰好到点但不带 pending → 算的是明天（由 pending 负责立即 tick）"));
assert.equal(delayOf(true, daily, at(2026, 11, 26, 9, 0), 5 * 60_000, true), 0, ok("恰好到点 + pending → 立即 tick"));
assert.equal(delayOf(true, daily, at(2026, 11, 26, 9, 30), 5 * 60_000, true), 0, ok("已过点（待补跑/记错过）→ 立即 tick"));
assert.equal(delayOf(false, daily, at(2026, 11, 26, 8, 0), 500), 500, ok("停用任务不参与，回落到兜底上限"));
assert.equal(delayOf(true, { frequency: "daily", time: "25:00" }, at(2026, 11, 26, 8, 0), 500), 500, ok("非法调度算不出下次 → 兜底上限"));
// 兜底上限：距下次很远时不会排一个超长定时器
assert.equal(delayOf(true, { frequency: "weekly", time: "09:00", days: [1] }, at(2026, 11, 26, 8, 0), 20_000), 20_000, ok("距下周一很远 → 被 maxDelay 截断"));
// 多个任务取最近那个
const multiDelay = nextTickDelay(
  [
    { enabled: true, schedule: daily },
    { enabled: true, schedule: { frequency: "hourly", minute: 30 } },
  ],
  at(2026, 11, 26, 8, 0),
  20_000,
  (s, at2) => nextRunAfter(s, at2),
);
assert.equal(multiDelay, 20_000, ok("多任务取最小延迟（hourly 也不足 20s 则被截断）"));
const multiDelay2 = nextTickDelay(
  [
    { enabled: true, schedule: daily },
    { enabled: true, schedule: { frequency: "hourly", minute: 30 } },
  ],
  at(2026, 11, 26, 8, 29),
  7_200_000,
  (s, at2) => nextRunAfter(s, at2),
);
assert.equal(multiDelay2, 61_000, ok("多任务：60s 后才是当前最近触发 → 61000ms"));

// 2026-11-26 实测事故：scheduleNextTick 用 `decideDueSlot(...).kind === "run"` 判
// pending，而那种情况只有「已到期槽位」才为真；「还有 2 分钟才到点」的任务被归到
// 300s 兜底，实际触发晚于计划时刻。下面直接模拟那个场景。
{
  const base = at(2026, 11, 26, 12, 27);
  const soon = { frequency: "daily", time: "12:29" };
  const delay = nextTickDelay(
    [{ enabled: true, schedule: soon, pending: false }],
    base,
    5 * 60_000,
    (s, t) => nextRunAfter(s, t),
  );
  assert.equal(delay, 121_000, "到点前 2 分钟：延时必须是 121s（精确），不能是 300s 兜底");
  assert.ok(delay < 5 * 60_000, "近距离触发不得被兜底上限截断");
}

console.log(`automation-schedule ok (${checks} 项断言通过)`);
