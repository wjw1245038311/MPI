import { formatDateKey } from "./todo-sections.ts";

/**
 * Smart date parsing for the todo quick-add input (Feishu-style): a recognized
 * date phrase is stripped from the title and becomes the due date. All math is
 * local time; `now` is injectable so tests are deterministic.
 */

export interface QuickAddParse {
  title: string;
  dueDate: string | null; // "YYYY-MM-DD" or null when no date phrase matched
}

const WEEKDAY_ZH: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const WEEKDAY_EN: Record<string, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
};

function addDays(base: Date, n: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
}

/** Build a calendar date; null when the day overflows (e.g. Feb 30). */
function makeDate(y: number, m1: number, d: number): Date | null {
  const dt = new Date(y, m1 - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m1 - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** This week's occurrence of weekday dow (Mon=1..Sun=0); next week's when already past. */
function thisWeekDow(dow: number, now: Date): Date {
  const offset = (now.getDay() + 6) % 7; // Mon=0 .. Sun=6
  const monday = addDays(now, -offset);
  let candidate = addDays(monday, dow === 0 ? 6 : dow - 1);
  if (candidate.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) {
    candidate = addDays(candidate, 7);
  }
  return candidate;
}

/** Next week's occurrence of weekday dow. */
function nextWeekDow(dow: number, now: Date): Date {
  const offset = (now.getDay() + 6) % 7;
  const monday = addDays(now, -offset);
  return addDays(monday, 7 + (dow === 0 ? 6 : dow - 1));
}

export function parseQuickAdd(raw: string, now: Date = new Date()): QuickAddParse {
  const text = raw.trim();
  let dueDate: string | null = null;
  let title = text;

  /** Try one pattern; on hit set dueDate and remove the phrase (plus a trailing
   * 前/之前 particle) from the title. */
  const tryMatch = (re: RegExp, resolve: (m: RegExpExecArray) => Date | null): boolean => {
    const m = re.exec(text);
    if (!m) return false;
    const d = resolve(m);
    if (!d) return false;
    dueDate = formatDateKey(d);
    // Drop the date phrase plus adjacent particles: 周五前提交 -> 提交; deploy on friday -> deploy.
    let left = text.slice(0, m.index).replace(/^\s*(?:on|by)(?=\s|$)/i, "").replace(/\s+(?:on|by)\s*$/i, "");
    let right = text.slice(m.index + m[0].length).replace(/^(之前|前)/, "").replace(/^\s*(?:on|by)(?=\s|$)/i, "");
    title = (left + " " + right).replace(/\s+/g, " ").trim();
    return true;
  };

  // 1. Absolute: YYYY-MM-DD / YYYY/MM/DD
  if (tryMatch(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/, (m) => makeDate(+m[1], +m[2], +m[3]))) return { title: title || text, dueDate };
  // 2. M月D日 / M月D号 (current year; no rollover — overdue entries stay put)
  if (tryMatch(/(\d{1,2})月(\d{1,2})[日号]?/, (m) => makeDate(now.getFullYear(), +m[1], +m[2]))) return { title: title || text, dueDate };
  // 3. MM-DD / M-D (validated as a real month/day; "PR-42" style tokens fail validation)
  if (tryMatch(/(?<!\d)(\d{1,2})-(\d{1,2})(?!\d)/, (m) => makeDate(now.getFullYear(), +m[1], +m[2]))) return { title: title || text, dueDate };
  // 4. Relative words — longest first ("day after tomorrow" before "tomorrow")
  if (tryMatch(/大后天|day after tomorrow/i, () => addDays(now, 3))) return { title: title || text, dueDate };
  if (tryMatch(/后天/, () => addDays(now, 2))) return { title: title || text, dueDate };
  if (tryMatch(/明天|明日|tomorrow/i, () => addDays(now, 1))) return { title: title || text, dueDate };
  if (tryMatch(/今天|today/i, () => now)) return { title: title || text, dueDate };
  // 5. Weekdays — "下周X" before bare "周X"; English next-X before bare X
  if (tryMatch(/下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/, (m) => nextWeekDow(WEEKDAY_ZH[m[1]], now))) return { title: title || text, dueDate };
  if (tryMatch(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, (m) => nextWeekDow(WEEKDAY_EN[m[1].toLowerCase()], now))) return { title: title || text, dueDate };
  if (tryMatch(/(?:周|星期|礼拜)([一二三四五六日天])/, (m) => thisWeekDow(WEEKDAY_ZH[m[1]], now))) return { title: title || text, dueDate };
  if (tryMatch(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, (m) => thisWeekDow(WEEKDAY_EN[m[1].toLowerCase()], now))) return { title: title || text, dueDate };

  return { title: text, dueDate: null };
}
