/**
 * 会话列表的时间口径（纯函数）。
 *
 * **这是 `src/renderer/src/lib/relative-time.ts` 的 vendored copy**——PWA 与渲染层是
 * 两套独立构建，PWA 不 import 渲染层代码（见 `mobile/pwa/src/components/icons.tsx` 顶部
 * 的同一约定）。行为一致性由 `scripts/test-pwa-relative-time.mjs` 守护：两边对同一批输入
 * 必须逐字相同，漂移在测试里失败。
 *
 * 为什么手机端也要这套口径：桌面端侧栏用「今天 / 昨天 / 本周 / 更早」分组表达时间，
 * 行内不放时间戳（`Sidebar.tsx` 的 `recentGroupLabel`）。PWA 抽屉里 140 个会话面临同一个
 * 问题，所以直接沿用同一套分桶与文案，不再自己发明第二套时间口径。
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

/** 行内时间文案（抽屉的项目头还在用；会话行已经改为分组表达，不再放行内时间）。 */
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

/**
 * 会话列表按自然日分段：返回该行之前应插入的组标题（不需要插标题时返回 null）。
 *
 * 与桌面端 `Sidebar.tsx` 的 `recentGroupLabel` 同一算法，但**不做置顶区豁免**：
 * 桌面端置顶区支持拖拽排序，插标题会打乱下标语义；PWA 抽屉没有拖拽，
 * 置顶行也照常参与分组（置顶的旧会话必须能被看出是旧的）。
 */
export function groupLabelAt(
  list: Array<{ updatedAt: number }>,
  index: number,
  now: number,
  zh: boolean,
): string | null {
  const bucket = dayBucket(list[index].updatedAt, now);
  if (index === 0) return bucketLabel(bucket, zh);
  return dayBucket(list[index - 1].updatedAt, now) === bucket ? null : bucketLabel(bucket, zh);
}
