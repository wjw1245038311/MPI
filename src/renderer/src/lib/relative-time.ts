/**
 * 会话列表的时间口径（纯函数，便于单测）。
 *
 * 起因：会话行只显示 `MM/DD HH:mm`，昨天的会话和今天的会话长得一样，
 * 用户在多条会话之间很容易点错（2026-10-18 反馈）。这里把「相对新鲜度」与
 * 「自然日分组」统一到一处，侧栏行内时间与分组标题共用同一套边界：
 *
 *   today（今天）/ yesterday（昨天）/ this-week（本周）/ earlier（更早）
 *
 * 本周 = 本周一 00:00 起；昨天优先于本周判断（周一那天，周日必须算「昨天」）。
 */

export type DayBucket = "today" | "yesterday" | "this-week" | "earlier";

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number): string => String(n).padStart(2, "0");
const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 时间戳落在哪个自然日桶里（`now` 可注入，便于测试）。 */
export function dayBucket(ts: number, now: number = Date.now()): DayBucket {
  const t = new Date(ts);
  const n = new Date(now);
  if (!Number.isFinite(ts)) return "earlier";
  const todayStart = startOfDay(n);
  const tsStart = startOfDay(t);
  if (tsStart >= todayStart) return "today";
  if (tsStart >= todayStart - 86_400_000) return "yesterday";
  // 本周一 00:00（getDay(): 周日=0 … 周六=6）
  const mondayOffset = (n.getDay() + 6) % 7;
  const weekStart = startOfDay(new Date(n.getFullYear(), n.getMonth(), n.getDate() - mondayOffset));
  return tsStart >= weekStart ? "this-week" : "earlier";
}

/** 分组标题文案。 */
export function bucketLabel(bucket: DayBucket, zh: boolean): string {
  switch (bucket) {
    case "today":
      return zh ? "今天" : "Today";
    case "yesterday":
      return zh ? "昨天" : "Yesterday";
    case "this-week":
      return zh ? "本周" : "This week";
    default:
      return zh ? "更早" : "Earlier";
  }
}

/** 行内时间文案。
 *
 * 一小时以内给相对时间（「刚刚」「12 分钟前」），更早一律给**带日期的绝对时间**——
 * 这正是「哪条是前几天的」需要一眼看清的信息，不为了简短把日期省掉：
 *   `今天 09:30` / `昨天 20:15` / `周三 14:02` / `10-15 14:02` / `2025-12-31 09:00`
 */
export function sessionTimeLabel(ts: number, zh: boolean, now: number = Date.now()): string {
  if (!Number.isFinite(ts)) return zh ? "未知时间" : "unknown";
  const diff = now - ts;
  if (diff >= 0 && diff < 60_000) return zh ? "刚刚" : "just now";
  if (diff >= 60_000 && diff < 3_600_000) {
    const m = Math.floor(diff / 60_000);
    return zh ? `${m} 分钟前` : `${m} min ago`;
  }
  const d = new Date(ts);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const bucket = dayBucket(ts, now);
  if (bucket === "today") return zh ? `今天 ${hm}` : `Today ${hm}`;
  if (bucket === "yesterday") return zh ? `昨天 ${hm}` : `Yesterday ${hm}`;
  if (bucket === "this-week") return zh ? `${WEEKDAY_ZH[d.getDay()]} ${hm}` : `${WEEKDAY_EN[d.getDay()]} ${hm}`;
  // 更早：同一年省掉年份，跨年必须带年份（否则「12-31」看着像去年）
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (d.getFullYear() === new Date(now).getFullYear()) return `${md} ${hm}`;
  return `${d.getFullYear()}-${md} ${hm}`;
}
