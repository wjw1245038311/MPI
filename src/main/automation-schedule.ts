/**
 * 定时任务的调度计算（纯函数，无 IO、无全局状态）。
 *
 * 从 automation.ts 里抽出来的原因：原来的 `matches()` 把「到点判断」写成
 * `HH:MM` 等值比较，只认那 60 秒窗口——主进程定时器在系统睡眠期间不补发，
 * 醒来时早已错过，于是整天空过且没有任何记录。同理 `slotKey()` 按日历天
 * 去重，导致把 09:00 改成 14:00 后当天不再触发。
 *
 * 这里的模型是「槽位（slot）」：
 *   - 一个槽位是调度计划里的一个具体时刻（datetime），不是日历天；
 *   - 槽位 id 用本地 ISO 时刻（`2026-11-26T09:00`），改时间/频率后 id 自然不同；
 *   - `dueRunsBetween(from, to)` 给出区间内所有已到点的槽位，由调用方决定
 *     补跑（在 catchUp 窗口内）还是记为错过（超窗口）。
 *
 * 时区语义：全部按本机本地时间计算；跨时区搬迁后旧槽位 id 不会重放，
 * 因为判断基准是「距上次槽位的时长」而不是 id 相等。
 */

import type { TaskSchedule } from "./config";

/** 补跑窗口默认值（分钟）。计划时刻错过但未超过该窗口时补跑一次。 */
export const DEFAULT_CATCH_UP_MINUTES = 120;

/** 每小时任务允许的最小间隔，防止用户误配出「每分钟」的失控任务。 */
export const MIN_INTERVAL_MINUTES = 15;

const pad = (n: number) => String(n).padStart(2, "0");

/** 槽位 id：本地时刻，精确到分钟。`2026-11-26T09:00` */
export function slotId(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 解析「一次性」时刻（本地 `YYYY-MM-DDTHH:MM`）；过去/非法返回 null。 */
export function parseOnceAt(value: unknown, now: Date = new Date()): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const at = new Date(year, month - 1, day, hour, minute, 0, 0);
  // Date 会把 2 月 31 日滚到 3 月，用回读校验挡掉这种「名义合法实际溢出」的值。
  if (at.getMonth() !== month - 1 || at.getDate() !== day) return null;
  return at;
}

/** 解析「HH:MM」；非法值返回 null（不静默当成 00:00，否则任务会在半夜跑）。 */
export function parseTimeOfDay(time: unknown): { hour: number; minute: number } | null {
  if (typeof time !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * 严格晚于 `after` 的下一个计划时刻。
 *
 * 非法调度（缺 time、`25:00`、weekly 但 days 为空）返回 null：
 * 这样的任务不会触发，由调用方决定是否在 UI 上标出来。
 */
export function nextSlotAfter(schedule: TaskSchedule, after: Date): Date | null {
  const from = new Date(after.getTime());

  if (schedule.frequency === "hourly") {
    const minute = schedule.minute ?? 0;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(minute);
    if (candidate.getTime() <= from.getTime()) candidate.setHours(candidate.getHours() + 1);
    return candidate;
  }

  if (schedule.frequency === "interval") {
    const step = schedule.intervalMinutes ?? 0;
    if (!Number.isInteger(step) || step < MIN_INTERVAL_MINUTES) return null;
    // 锚定到自然日的整点倍数（如每 15 分钟 → :00/:15/:30/:45），而不是锚定到
    // 「上一次运行」：后者会随每次运行漂移累积，且重启后基准丢失。
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setMilliseconds(0);
    const minutesOfDay = candidate.getHours() * 60 + candidate.getMinutes();
    const nextMinutes = (Math.floor(minutesOfDay / step) + 1) * step;
    candidate.setHours(0, 0, 0, 0);
    candidate.setMinutes(nextMinutes);
    return candidate;
  }

  if (schedule.frequency === "once") {
    const at = parseOnceAt(schedule.onceAt);
    if (!at) return null;
    return at.getTime() > from.getTime() ? at : null;
  }

  const tod = parseTimeOfDay(schedule.time);
  if (!tod) return null;

  if (schedule.frequency === "daily") {
    const candidate = new Date(from);
    candidate.setHours(tod.hour, tod.minute, 0, 0);
    if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  if (schedule.frequency === "weekly") {
    const days = Array.isArray(schedule.days) ? schedule.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    if (days.length === 0) return null;
    // 最多找 8 天：今天余下时刻已过时，下一个命中日可能落在下一周同一星期。
    const base = startOfDay(from);
    for (let offset = 0; offset <= 7; offset++) {
      const day = addDays(base, offset);
      if (!days.includes(day.getDay())) continue;
      const candidate = new Date(day);
      candidate.setHours(tod.hour, tod.minute, 0, 0);
      if (candidate.getTime() > from.getTime()) return candidate;
    }
    return null;
  }

  return null;
}

/**
 * 区间 `(after, until]` 内所有计划时刻，按时间升序。
 *
 * `limit` 是安全阀：系统长时间休眠后 `after` 可能距今几个月，逐小时枚举会
 * 拖住主进程。调用方通常只需要「最近若干个」来判断补跑，故默认上限取 500。
 */
export function slotsBetween(schedule: TaskSchedule, after: Date, until: Date, limit = 500): Date[] {
  const out: Date[] = [];
  let cursor = new Date(after.getTime());
  while (out.length < limit) {
    const next = nextSlotAfter(schedule, cursor);
    if (!next || next.getTime() > until.getTime()) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** `(after, until]` 内最近的一个计划时刻；没有则 null。 */
export function latestSlotBetween(schedule: TaskSchedule, after: Date, until: Date): Date | null {
  const all = slotsBetween(schedule, after, until);
  return all.length ? all[all.length - 1] : null;
}

/** 严格晚于 `after` 的下一次触发时刻（面板「下次运行」用同一个函数，避免两套算法）。 */
export function nextRunAfter(schedule: TaskSchedule, after: Date): Date | null {
  return nextSlotAfter(schedule, after);
}

export type SlotDecision =
  /** 没有待处理的槽位（或调度非法）：什么都不做。 */
  | { kind: "none"; reason: "invalid" | "nothing-due" }
  /** 有已到点且仍在补跑窗口内的槽位：应当执行。 */
  | { kind: "run"; slot: Date; missedCount: number }
  /** 有已到点的槽位但已超过补跑窗口：只记录错过，不执行。 */
  | { kind: "missed"; slot: Date; missedCount: number };

/**
 * 判定 `lastSlot`（上次处理到的槽位，null = 从未运行）到 `now` 之间应当做什么。
 *
 * - 超过一个槽位到期时合并成一次运行（`missedCount` 告知合并了几个），
 *   避免休眠一夜后连开 8 个 pi 进程；
 * - 最近槽位超出 `catchUpMinutes` 时不再补跑，只报错过；
 * - `catchUpMinutes <= 0` 表示关闭补跑：只有恰好落在当前分钟内才执行。
 *
 * `lastSlot` 为 null 时以 `firstSeenAt` 为基准，避免「刚装好就把当天早些时候
 * 该跑的任务全部补一遍」。
 */
export function decideDueSlot(params: {
  schedule: TaskSchedule;
  lastSlot: Date | null;
  firstSeenAt: Date | null;
  now: Date;
  catchUpMinutes: number;
}): SlotDecision {
  const { schedule, lastSlot, firstSeenAt, now } = params;
  const catchUp = Number.isFinite(params.catchUpMinutes) ? Math.max(0, params.catchUpMinutes) : DEFAULT_CATCH_UP_MINUTES;

  // 从未处理过槽位：基准取「创建/首次见到」与「现在」中较早者。
  // 用 now 做基准会让第一次判断永远没有到期槽位（nextSlotAfter 严格晚于 now），
  // 用 firstSeenAt 才能补上「应用装好后第一次启动前已经过去」的那个槽位。
  const basis = lastSlot ?? firstSeenAt ?? null;
  if (!basis) return { kind: "none", reason: "nothing-due" };
  if (basis.getTime() >= now.getTime()) return { kind: "none", reason: "nothing-due" };

  const slots = slotsBetween(schedule, basis, now);
  if (slots.length === 0) return { kind: "none", reason: "nothing-due" };

  const latest = slots[slots.length - 1];
  const missedCount = slots.length - 1; // 被合并掉的更早槽位
  const ageMinutes = (now.getTime() - latest.getTime()) / 60_000;

  if (ageMinutes <= catchUp) return { kind: "run", slot: latest, missedCount };
  return { kind: "missed", slot: latest, missedCount };
}

/** 距下一次 tick 的延时（毫秒）。
 *
 * 语义：
 *   - 有任务「已到点未处理」（pending，例如上一轮还在跑而被跳过）→ 0，立即重判；
 *   - 否则取所有启用任务里最近的下次触发时刻，+1s 偏移；
 *   - 再被 maxDelayMs 截断（兜底重判：时钟被拨动 / 调度非法时仍能恢复）。
 *
 * 2026-11-26 实测教训：这个值与「任务还有多久到点」必须是同一个判据。
 * 早期版本用 `decideDueSlot(...).kind === "run"` 判 pending，而那个函数只在
 * 「已有到期槽位」时返回 run——「2 分钟后才到期」的任务 pending=false，
 * 被排进 5 分钟兜底，于是实际触发晚于计划时刻。
 */
export function nextTickDelay(
  tasks: Array<{ enabled: boolean; schedule: TaskSchedule; pending?: boolean }>,
  now: Date,
  maxDelayMs: number,
  nextOf: (schedule: TaskSchedule, now: Date) => Date | null,
): number {
  let delay = maxDelayMs;
  for (const item of tasks) {
    if (!item.enabled) continue;
    // 有待处理槽位：立刻重判。
    if (item.pending) return 0;
    const next = nextOf(item.schedule, now);
    if (!next) continue;
    const diff = next.getTime() - now.getTime();
    if (diff <= 0) return 0;
    // +1s 偏移：避免在槽位那一毫秒前后抖动出「差 1ms 还没到点」。
    delay = Math.min(delay, diff + 1000);
  }
  return Math.max(0, delay);
}

/** 人类可读的调度描述（面板与单测共用，避免两处各写一套）。 */
export function describeSchedule(schedule: TaskSchedule, language: "en" | "zh"): string {
  const dayNames = language === "zh"
    ? ["日", "一", "二", "三", "四", "五", "六"]
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  if (schedule.frequency === "hourly") {
    const minute = schedule.minute ?? 0;
    return language === "zh" ? `每小时 第 ${minute} 分钟` : `Hourly at minute ${minute}`;
  }

  if (schedule.frequency === "interval") {
    const step = schedule.intervalMinutes ?? 0;
    return language === "zh" ? `每 ${step} 分钟` : `Every ${step} minutes`;
  }

  if (schedule.frequency === "once") {
    const at = parseOnceAt(schedule.onceAt);
    const when = at
      ? `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
      : schedule.onceAt || "—";
    return language === "zh" ? `一次：${when}` : `Once at ${when}`;
  }

  const tod = parseTimeOfDay(schedule.time);
  const time = tod ? `${pad(tod.hour)}:${pad(tod.minute)}` : (schedule.time || "—");

  if (schedule.frequency === "daily") {
    return language === "zh" ? `每天 ${time}` : `Daily at ${time}`;
  }

  const days = (Array.isArray(schedule.days) ? schedule.days : [])
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .map((d) => dayNames[d])
    .join(language === "zh" ? "、" : ", ");
  return language === "zh" ? `每周 ${days || "—"} ${time}` : `Weekly on ${days || "—"} at ${time}`;
}
