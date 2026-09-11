import { formatDateKey } from "./todo-sections.ts";

/**
 * Smart date/time parsing for the todo quick-add input (Feishu-style): a
 * recognized date phrase is stripped from the title and becomes the due date,
 * and an optional time phrase (14:30 / 9点 / 下午3点半 / 9am) refines it to the
 * minute. A bare time with no date means "today". All math is local time;
 * `now` is injectable so tests are deterministic.
 */

export interface QuickAddParse {
  title: string;
  dueDate: string | null; // "YYYY-MM-DD" or null when no date phrase matched
  dueTime: string | null; // "HH:mm" (24h) or null — only meaningful with a dueDate
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
  const original = raw.trim();
  let text = original;
  let dueDate: string | null = null;
  let dueTime: string | null = null;
  let title = original;

  /** Try one date pattern; on hit set dueDate and remove the phrase (plus a
   * trailing 前/之前 particle) from the remaining text. */
  const tryDate = (re: RegExp, resolve: (m: RegExpExecArray) => Date | null): boolean => {
    const m = re.exec(text);
    if (!m) return false;
    const d = resolve(m);
    if (!d) return false;
    dueDate = formatDateKey(d);
    // Drop the date phrase plus adjacent particles: 周五前提交 -> 提交; deploy on friday -> deploy.
    let left = text.slice(0, m.index).replace(/^\s*(?:on|by)(?=\s|$)/i, "").replace(/\s+(?:on|by)\s*$/i, "");
    let right = text.slice(m.index + m[0].length).replace(/^(之前|前)/, "").replace(/^\s*(?:on|by)(?=\s|$)/i, "");
    title = (left + " " + right).replace(/\s+/g, " ").trim();
    text = title; // later patterns (time) run on the remainder
    return true;
  };

  /** Try one time pattern; on hit set dueTime and remove the phrase. */
  const tryTime = (re: RegExp, resolve: (m: RegExpExecArray) => string | null): boolean => {
    const m = re.exec(text);
    if (!m) return false;
    const t = resolve(m);
    if (!t) return false; // e.g. 25:99 — let the other patterns try
    dueTime = t;
    let left = text.slice(0, m.index).replace(/\s+$/, "");
    let right = text.slice(m.index + m[0].length).replace(/^(之前|前)/, "").replace(/^\s+/, "");
    title = (left + " " + right).replace(/\s+/g, " ").trim();
    return true;
  };

  // Date phrases — first hit wins.
  // 1. Absolute: YYYY-MM-DD / YYYY/MM/DD
  if (!tryDate(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/, (m) => makeDate(+m[1], +m[2], +m[3]))) {
    // 2. M月D日 / M月D号 (current year; no rollover — overdue entries stay put)
    if (!tryDate(/(\d{1,2})月(\d{1,2})[日号]?/, (m) => makeDate(now.getFullYear(), +m[1], +m[2]))) {
      // 3. MM-DD / M-D (validated as a real month/day; "PR-42" style tokens fail validation)
      if (!tryDate(/(?<!\d)(\d{1,2})-(\d{1,2})(?!\d)/, (m) => makeDate(now.getFullYear(), +m[1], +m[2]))) {
        // 4. Relative words — longest first ("day after tomorrow" before "tomorrow")
        if (!tryDate(/大后天|day after tomorrow/i, () => addDays(now, 3))) {
          if (!tryDate(/后天/, () => addDays(now, 2))) {
            if (!tryDate(/明天|明日|tomorrow/i, () => addDays(now, 1))) {
              tryDate(/今天|today/i, () => now);
            }
          }
        }
      }
    }
  }
  // Weekdays — "下周X" before bare "周X"; English next-X before bare X.
  // Only when no date phrase matched yet (one deadline per input).
  if (!dueDate) {
    if (!tryDate(/下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/, (m) => nextWeekDow(WEEKDAY_ZH[m[1]], now))) {
      if (!tryDate(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, (m) => nextWeekDow(WEEKDAY_EN[m[1].toLowerCase()], now))) {
        if (!tryDate(/(?:周|星期|礼拜)([一二三四五六日天])/, (m) => thisWeekDow(WEEKDAY_ZH[m[1]], now))) {
          tryDate(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, (m) => thisWeekDow(WEEKDAY_EN[m[1].toLowerCase()], now));
        }
      }
    }
  }

  // Time phrases — first hit wins. A bare time with no date means "today".
  if (!tryTime(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/, (m) => {
    const h = +m[1];
    return h <= 23 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
  })) {
    // Chinese: [上午|早上|中午|下午|晚上]H点(半|一刻|M分)?钟?
    if (!tryTime(/((?:上午|早上|早晨|中午|下午|晚上))?(\d{1,2})\s*点(?:(半)|(一刻)|(\d{1,2})\s*分?)?钟?/, (m) => {
      let h = +m[2];
      if (h > 23) return null;
      const min = m[3] ? 30 : m[4] ? 15 : m[5] ? +m[5] : 0;
      if (min > 59) return null;
      const period = m[1];
      if ((period === "下午" || period === "晚上") && h < 12) h += 12;
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    })) {
      // English: 9am / 9:30 pm
      tryTime(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (m) => {
        let h = +m[1];
        const min = m[2] ? +m[2] : 0;
        if (h < 1 || h > 12 || min > 59) return null;
        const ap = m[3].toLowerCase();
        if (ap === "pm" && h !== 12) h += 12;
        if (ap === "am" && h === 12) h = 0;
        return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      });
    }
  }

  if (dueTime && !dueDate) dueDate = formatDateKey(now);
  return { title: title || original, dueDate, dueTime };
}
