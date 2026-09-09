import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "./config";
import type { TodoItem } from "../renderer/src/lib/types";

/**
 * Personal todo list (Feishu-style smart sections, see renderer lib/todo-sections.ts).
 * Todos are scoped per project (cwd) so the panel can filter by project.
 *
 * Stored as a single JSON array under the app's userData dir (next to
 * config.json and drafts.json, so dev/prod profiles stay separated like every
 * other setting). The main process is the ONLY writer of todos.json: writes are
 * coalesced into one atomic flush (tmp + rename) so a crash never leaves a torn
 * file. Agent-side additions arrive through the inbox directory instead (see
 * ingestInbox below), which keeps two processes from racing on the same file.
 */

/** Hard caps keep the file small and the panel rows sane. */
const MAX_TITLE = 500;
const MAX_NOTE = 2000;
/** Coalesce rapid edits into one disk flush. */
const FLUSH_MS = 300;

let todos: TodoItem[] | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function file(): string {
  return join(getConfigDir(), "todos.json");
}

/** Validate a "YYYY-MM-DD" local date (calendar-valid, not just shaped right). */
export function isValidDueDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

function sanitizeItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim().slice(0, MAX_TITLE) : "";
  if (!title) return null; // a todo without a title is useless — drop it on load
  const note = typeof r.note === "string" && r.note.length > 0 ? r.note.slice(0, MAX_NOTE) : undefined;
  const dueDate = isValidDueDate(r.dueDate) ? (r.dueDate as string) : null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : randomUUID(),
    title,
    note,
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    dueDate,
    done: !!r.done,
    createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    completedAt: typeof r.completedAt === "number" && Number.isFinite(r.completedAt) ? r.completedAt : null,
    source: r.source === "agent" ? "agent" : "user",
    sessionFile: typeof r.sessionFile === "string" && r.sessionFile ? r.sessionFile : undefined,
  };
}

function ensureLoaded(): TodoItem[] {
  if (todos) return todos;
  const list: TodoItem[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(), "utf8"));
    if (Array.isArray(parsed)) {
      for (const raw of parsed) {
        const item = sanitizeItem(raw);
        if (item) list.push(item);
      }
    }
  } catch {
    // Missing or corrupt file -> start empty. A corrupt file is left in place
    // for inspection; the next flush overwrites it atomically.
  }
  todos = list;
  return list;
}

function writeNow(): void {
  const list = ensureLoaded();
  try {
    const target = file();
    const tmp = target + ".tmp";
    writeFileSync(tmp, JSON.stringify(list));
    renameSync(tmp, target);
  } catch (e) {
    console.error("[todos] persist failed:", e);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeNow();
  }, FLUSH_MS);
}

export function listTodos(): TodoItem[] {
  // Copy so callers cannot mutate the in-memory store.
  return ensureLoaded().map((t) => ({ ...t }));
}

/** Create a todo from a quick-add title. Returns null when the title is empty. */
export function addTodo(args: { cwd?: unknown; title?: unknown; note?: unknown; dueDate?: unknown }): TodoItem | null {
  const clean = typeof args?.title === "string" ? args.title.trim() : "";
  if (!clean) return null;
  const item: TodoItem = {
    id: randomUUID(),
    title: clean.slice(0, MAX_TITLE),
    note: typeof args.note === "string" && args.note.length > 0 ? args.note.slice(0, MAX_NOTE) : undefined,
    cwd: typeof args.cwd === "string" ? args.cwd : "",
    dueDate: isValidDueDate(args.dueDate) ? (args.dueDate as string) : null,
    done: false,
    createdAt: Date.now(),
    completedAt: null,
    source: "user",
  };
  ensureLoaded().push(item);
  scheduleFlush();
  return { ...item };
}

export interface TodoPatch {
  title?: unknown;
  note?: unknown;
  dueDate?: unknown; // "YYYY-MM-DD" or null to clear
}

/** Apply a partial update. Returns the updated item, or null when not found / invalid. */
export function updateTodo(id: unknown, patch: TodoPatch): TodoItem | null {
  const list = ensureLoaded();
  const item = typeof id === "string" ? list.find((t) => t.id === id) : undefined;
  if (!item) return null;

  if (patch.title !== undefined) {
    const clean = typeof patch.title === "string" ? patch.title.trim() : "";
    if (!clean) return null; // never allow saving an empty title
    item.title = clean.slice(0, MAX_TITLE);
  }
  if (patch.note !== undefined) {
    item.note = typeof patch.note === "string" && patch.note.length > 0 ? patch.note.slice(0, MAX_NOTE) : undefined;
  }
  if (patch.dueDate !== undefined) {
    item.dueDate = isValidDueDate(patch.dueDate) ? (patch.dueDate as string) : null;
  }
  scheduleFlush();
  return { ...item };
}

export function toggleTodo(id: unknown): TodoItem | null {
  const list = ensureLoaded();
  const item = typeof id === "string" ? list.find((t) => t.id === id) : undefined;
  if (!item) return null;
  item.done = !item.done;
  item.completedAt = item.done ? Date.now() : null;
  scheduleFlush();
  return { ...item };
}

export function deleteTodo(id: unknown): boolean {
  const list = ensureLoaded();
  const idx = typeof id === "string" ? list.findIndex((t) => t.id === id) : -1;
  if (idx < 0) return false;
  list.splice(idx, 1);
  scheduleFlush();
  return true;
}

/** Remove completed todos for one project (cwd), or all projects when cwd is null. */
export function clearCompletedTodos(cwd: unknown): number {
  const list = ensureLoaded();
  const scope = typeof cwd === "string" ? cwd : null;
  const before = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].done) continue;
    if (scope !== null && list[i].cwd !== scope) continue;
    list.splice(i, 1);
  }
  const removed = before - list.length;
  if (removed > 0) scheduleFlush();
  return removed;
}

/** Synchronous final flush — call on app quit so the coalesced write cannot be lost. */
export function flushTodos(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  writeNow();
}

// ---------------------------------------------------------------------------
// Inbox: agent-side additions arrive as one JSON file per todo in
// <userData>/todos-inbox/. The pi extension never touches todos.json, so the
// main process stays the single writer. Ingest validates + dedupes by id and
// deletes consumed files; a corrupt file is left for inspection (and skipped).
// ---------------------------------------------------------------------------

export function inboxDir(): string {
  return join(getConfigDir(), "todos-inbox");
}

/** Consume pending inbox files. Returns the newly added items (empty when none). */
export function ingestInbox(): TodoItem[] {
  const dir = inboxDir();
  let entries: string[];
  try {
    // readdirSync on a missing dir throws — that is the normal "no inbox yet" case.
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const added: TodoItem[] = [];
  const list = ensureLoaded();
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    let item: TodoItem | null = null;
    try {
      item = sanitizeItem(JSON.parse(readFileSync(join(dir, name), "utf8")));
    } catch {
      continue; // corrupt file — leave it in place for inspection
    }
    if (!item) continue;
    const path = join(dir, name);
    if (list.some((t) => t.id === item!.id)) {
      // Duplicate delivery (e.g. watcher + poll race) — just consume the file.
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
      continue;
    }
    list.push(item);
    added.push({ ...item });
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
  if (added.length > 0) scheduleFlush();
  return added;
}
