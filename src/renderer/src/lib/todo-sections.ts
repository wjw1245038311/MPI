import type { TodoItem } from "./types";

/**
 * Feishu-style smart sections for the 待办任务 panel. The open-item sections are
 * mutually exclusive (an item lands in exactly one of today/tomorrow/week/later/
 * nodate); "all" is their union and "done" holds completed items. All date math
 * is local time — dueDate strings are local "YYYY-MM-DD", never UTC.
 */

export type TodoSectionId = "all" | "today" | "tomorrow" | "week" | "later" | "nodate" | "done";

/** Display order of the section chips (counts come from sectionCounts). */
export const TODO_SECTION_ORDER: TodoSectionId[] = ["all", "today", "tomorrow", "week", "later", "nodate", "done"];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local "YYYY-MM-DD" of a date. */
export function formatDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse a local "YYYY-MM-DD" into a start-of-day Date, or null when invalid. */
export function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

/** Monday of the week containing `now` (local). */
function mondayOf(now: Date): number {
  const offset = (now.getDay() + 6) % 7; // Mon=0 .. Sun=6
  return startOfDay(now) - offset * 86_400_000;
}

/** Which smart section an item belongs to. */
export function sectionFor(item: Pick<TodoItem, "dueDate" | "done">, now: Date = new Date()): TodoSectionId {
  if (item.done) return "done";
  const due = item.dueDate ? parseDateKey(item.dueDate) : null;
  if (!due) return "nodate";
  const today = startOfDay(now);
  const tomorrow = today + 86_400_000;
  const monday = mondayOf(now);
  const sunday = monday + 6 * 86_400_000;
  if (due.getTime() <= today) return "today"; // includes overdue — Feishu shows those under Today
  if (due.getTime() === tomorrow) return "tomorrow";
  if (due.getTime() > today && due.getTime() <= sunday) return "week";
  return "later";
}

/** Count items per section (open sections are mutually exclusive). */
export function sectionCounts(items: TodoItem[], now: Date = new Date()): Record<TodoSectionId, number> {
  const counts: Record<TodoSectionId, number> = { all: 0, today: 0, tomorrow: 0, week: 0, later: 0, nodate: 0, done: 0 };
  for (const item of items) {
    const s = sectionFor(item, now);
    if (s === "done") counts.done++;
    else {
      counts.all++;
      counts[s]++;
    }
  }
  return counts;
}

/** Items in one section. `all` returns every open item. */
export function filterBySection(items: TodoItem[], section: TodoSectionId, now: Date = new Date()): TodoItem[] {
  if (section === "all") return items.filter((t) => !t.done);
  return items.filter((t) => sectionFor(t, now) === section);
}

/** Display order inside a section: dated first (overdue at the top), undated last. */
export function sortTodos(items: TodoItem[]): TodoItem[] {
  const key = (t: TodoItem) => t.dueDate ?? "9999-12-31";
  return [...items].sort((a, b) => (key(a) === key(b) ? a.createdAt - b.createdAt : key(a) < key(b) ? -1 : 1));
}

/** True when an open item's due date is before today. */
export function isOverdue(item: Pick<TodoItem, "dueDate" | "done">, now: Date = new Date()): boolean {
  if (item.done || !item.dueDate) return false;
  const due = parseDateKey(item.dueDate);
  return !!due && due.getTime() < startOfDay(now);
}

/** Compact chip label for a due date: 今天 / 明天 / MM-DD. */
export function dueLabel(dueDate: string, now: Date = new Date()): string {
  const due = parseDateKey(dueDate);
  if (!due) return dueDate;
  const today = startOfDay(now);
  if (due.getTime() === today) return "今天";
  if (due.getTime() === today + 86_400_000) return "明天";
  return formatDateKey(due).slice(5); // MM-DD
}
