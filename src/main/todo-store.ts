import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { getConfig, getConfigDir } from "./config";
import type { TodoAttachment, TodoItem } from "../renderer/src/lib/types";

/**
 * Personal todo list (Feishu-style smart sections, see renderer lib/todo-sections.ts).
 * Todos are scoped per project (cwd) so the panel can filter by project.
 *
 * Stored as a single JSON array under the app's userData dir (next to
 * config.json and drafts.json, so dev/prod profiles stay separated like every
 * other setting). When config.todoDataDir is set (Settings → 数据存储),
 * everything lives under that folder instead: todos.json / todo-attachments/
 * / todos-inbox/ — old locations keep working as fallback lookup sources.
 *
 * The main process is the ONLY writer of todos.json: writes are
 * coalesced into one atomic flush (tmp + rename) so a crash never leaves a torn
 * file. Agent-side additions arrive through the inbox directory instead (see
 * ingestInbox below), which keeps two processes from racing on the same file.
 */

/** Hard caps keep the file small and the panel rows sane. */
const MAX_TITLE = 500;
const MAX_NOTE = 2000;
/** Attachment limits: a todo is a list row, not a drive — screenshots are the
 * main use case, so 10 files / 25 MB each keeps todos.json and the panel light. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;
/** Coalesce rapid edits into one disk flush. */
const FLUSH_MS = 300;

let todos: TodoItem[] | null = null;
let flushTimer: NodeJS.Timeout | null = null;

/** Absolute path of the todos JSON (respects config.todoDataDir). */
export function todosFilePath(): string {
  const custom = (getConfig().todoDataDir || "").trim();
  return custom ? join(custom, "todos.json") : join(getConfigDir(), "todos.json");
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

/** Validate a local "HH:mm" time (24h clock). */
export function isValidDueTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return false;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

/** Normalize a "HH:mm" time to zero-padded form ("9:05" -> "09:05"). */
function normalizeDueTime(value: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())!;
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

/** Strict shape of an attachment file name (uuid + sanitized extension).
 * Every resolver (protocol, openPath, unlink) re-checks it before touching disk. */
const ATTACHMENT_FILE_RE = /^[a-f0-9-]{8,}\.[a-z0-9]+$/i;

/** Sanitize a stored attachment file name: uuid + short lowercase extension.
 * The protocol handler re-validates this shape before serving. */
function safeAttachmentFile(id: string, originalName: unknown): string {
  const base = typeof originalName === "string" ? originalName : "";
  let ext = extname(base).replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (!ext) ext = "bin";
  return `${id}.${ext}`;
}

function sanitizeAttachment(raw: unknown): TodoAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id ? r.id : "";
  // Same strict shape the protocol/openPath resolvers require — anything else
  // cannot be served or opened, so drop it.
  const file = typeof r.file === "string" && ATTACHMENT_FILE_RE.test(r.file) ? r.file : "";
  if (!id || !file) return null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.slice(0, 256) : file;
  const mime = typeof r.mime === "string" && /^\S+\/\S+$/.test(r.mime) ? r.mime.slice(0, 128) : "application/octet-stream";
  const size = typeof r.size === "number" && Number.isFinite(r.size) && r.size >= 0 ? Math.floor(r.size) : 0;
  return { id, name, mime, size, file };
}

function sanitizeItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim().slice(0, MAX_TITLE) : "";
  if (!title) return null; // a todo without a title is useless — drop it on load
  const note = typeof r.note === "string" && r.note.length > 0 ? r.note.slice(0, MAX_NOTE) : undefined;
  const dueDate = isValidDueDate(r.dueDate) ? (r.dueDate as string) : null;
  // A time without a date is meaningless — drop it. Invalid times normalize to
  // null so old/corrupt rows keep working.
  let dueTime: string | null = null;
  if (dueDate && isValidDueTime(r.dueTime)) dueTime = normalizeDueTime(r.dueTime as string);
  const attachments = Array.isArray(r.attachments)
    ? r.attachments.map(sanitizeAttachment).filter((a): a is TodoAttachment => !!a).slice(0, MAX_ATTACHMENTS)
    : undefined;
  return {
    id: typeof r.id === "string" && r.id ? r.id : randomUUID(),
    title,
    note,
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    dueDate,
    ...(dueTime !== null ? { dueTime } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
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
    const parsed: unknown = JSON.parse(readFileSync(todosFilePath(), "utf8"));
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
    const target = todosFilePath();
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

/** Create a todo from a quick-add title. Returns null when the title is empty.
 * A dueTime without a dueDate is ignored (a time alone cannot be scheduled). */
export function addTodo(args: {
  cwd?: unknown;
  title?: unknown;
  note?: unknown;
  dueDate?: unknown;
  dueTime?: unknown; // "HH:mm" or null
}): TodoItem | null {
  const clean = typeof args?.title === "string" ? args.title.trim() : "";
  if (!clean) return null;
  const dueDate = isValidDueDate(args.dueDate) ? (args.dueDate as string) : null;
  const item: TodoItem = {
    id: randomUUID(),
    title: clean.slice(0, MAX_TITLE),
    note: typeof args.note === "string" && args.note.length > 0 ? args.note.slice(0, MAX_NOTE) : undefined,
    cwd: typeof args.cwd === "string" ? args.cwd : "",
    dueDate,
    ...(dueDate && isValidDueTime(args.dueTime) ? { dueTime: normalizeDueTime(args.dueTime as string) } : {}),
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
  dueTime?: unknown; // "HH:mm" or null to clear (also cleared when the date is)
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
  if (patch.dueDate !== undefined || patch.dueTime !== undefined) {
    // The date and time form one deadline: changing either re-validates the
    // pair, and clearing the date always clears the time with it.
    const nextDate =
      patch.dueDate !== undefined ? (isValidDueDate(patch.dueDate) ? (patch.dueDate as string) : null) : item.dueDate;
    let nextTime: string | null = null;
    if (nextDate) {
      const timeSource = patch.dueTime !== undefined ? patch.dueTime : item.dueTime ?? null;
      if (timeSource === null || timeSource === "") nextTime = null; // explicit clear
      else if (isValidDueTime(timeSource)) nextTime = normalizeDueTime(timeSource as string);
    }
    item.dueDate = nextDate;
    if (nextTime !== null) item.dueTime = nextTime;
    else delete item.dueTime;
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
  const [removed] = list.splice(idx, 1);
  unlinkAttachments(removed); // best-effort: orphaned files are harmless
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
    const [removed] = list.splice(i, 1);
    unlinkAttachments(removed);
  }
  const removedCount = before - list.length;
  if (removedCount > 0) scheduleFlush();
  return removedCount;
}

// ---------------------------------------------------------------------------
// Attachments: binaries live in <userData>/todo-attachments/ as one file per
// attachment (<uuid>.<ext>); todos.json only keeps the metadata. The renderer
// displays images through the todoatt:// protocol (see todo-attachment-
// protocol.ts) and opens other files via shell.openPath.
// ---------------------------------------------------------------------------

/** Built-in location: <userData>/todo-attachments. */
export function defaultAttachmentsDir(): string {
  return join(getConfigDir(), "todo-attachments");
}

/** Active attachment dir: <todoDataDir>/todo-attachments when the todo data
 * location is customized, else the legacy user-configured dir, else the
 * built-in default. */
export function attachmentsDir(): string {
  const dataDir = (getConfig().todoDataDir || "").trim();
  if (dataDir) return join(dataDir, "todo-attachments");
  const custom = (getConfig().todoAttachmentDir || "").trim();
  return custom ? custom : defaultAttachmentsDir();
}

/** Every directory that may hold attachment files, in lookup order: the active
 * dir first, then every previously-used location — files added before a
 * location change stay where they were and must keep resolving. */
export function allAttachmentDirs(): string[] {
  const dirs = [attachmentsDir()];
  const legacy = (getConfig().todoAttachmentDir || "").trim();
  if (legacy && !dirs.includes(legacy)) dirs.push(legacy);
  const def = defaultAttachmentsDir();
  if (!dirs.includes(def)) dirs.push(def);
  return dirs;
}

/** Best-effort removal of an item's attachment files. */
function unlinkAttachments(item: TodoItem | undefined): void {
  if (!item?.attachments) return;
  for (const att of item.attachments) {
    // Re-check the shape before touching disk — metadata is sanitized on
    // load, but a hand-edited file could still carry junk.
    if (!ATTACHMENT_FILE_RE.test(att.file)) continue;
    for (const dir of allAttachmentDirs()) {
      try {
        unlinkSync(join(dir, att.file));
      } catch {
        /* not in this dir — keep looking / already gone */
      }
    }
  }
}

export interface AddAttachmentInput {
  name?: unknown; // original file name (display)
  mime?: unknown;
  data: Buffer | Uint8Array;
}

/** Attach one or more files to a todo. Returns the updated item plus per-file
 * errors (size cap / attachment cap); nothing is written for rejected files. */
export function addAttachments(
  id: unknown,
  inputs: AddAttachmentInput[]
): { item: TodoItem | null; added: number; skipped: string[]; errors: string[] } {
  const list = ensureLoaded();
  const item = typeof id === "string" ? list.find((t) => t.id === id) : undefined;
  if (!item) return { item: null, added: 0, skipped: [], errors: ["todo not found"] };
  if (!Array.isArray(inputs) || inputs.length === 0)
    return { item: { ...item }, added: 0, skipped: [], errors: [] };

  const dir = attachmentsDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { item: null, added: 0, skipped: [], errors: [String(e instanceof Error ? e.message : e)] };
  }

  const atts = item.attachments ? [...item.attachments] : [];
  let added = 0;
  const skipped: string[] = [];
  const errors: string[] = [];
  for (const input of inputs) {
    if (!input || !Buffer.isBuffer(input.data) && !(input.data instanceof Uint8Array)) {
      errors.push("invalid file data");
      continue;
    }
    const size = input.data.byteLength;
    if (size === 0) {
      errors.push(`${String(input.name ?? "file")}: empty file`);
      continue;
    }
    if (size > MAX_ATTACHMENT_SIZE) {
      errors.push(`${String(input.name ?? "file")}: exceeds ${Math.floor(MAX_ATTACHMENT_SIZE / 1024 / 1024)} MB limit`);
      continue;
    }
    if (atts.length >= MAX_ATTACHMENTS) {
      errors.push(`attachment limit reached (${MAX_ATTACHMENTS} per todo)`);
      break;
    }
    const attId = randomUUID();
    const file = safeAttachmentFile(attId, input.name);
    const name = typeof input.name === "string" && input.name.trim() ? input.name.slice(0, 256) : file;
    // Dedupe: the same file (name + size) is already attached to this todo —
    // e.g. pasting one screenshot twice must not create a second copy.
    if (atts.some((a) => a.name === name && a.size === size)) {
      skipped.push(name);
      continue;
    }
    try {
      writeFileSync(join(dir, file), Buffer.from(input.data));
    } catch (e) {
      errors.push(`${name}: ${String(e instanceof Error ? e.message : e)}`);
      continue;
    }
    let mime = typeof input.mime === "string" && /^\S+\/\S+$/.test(input.mime) ? input.mime.slice(0, 128) : "";
    if (!mime) {
      // Fall back to the extension so pasted files without a type still preview.
      const ext = file.split(".").pop() || "";
      mime =
        { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" }[ext] ||
        "application/octet-stream";
    }
    atts.push({ id: attId, name, mime, size, file });
    added++;
  }

  if (added > 0) {
    item.attachments = atts;
    scheduleFlush();
  }
  return { item: { ...item }, added, skipped, errors };
}

/** Detach one attachment from a todo and delete its file. */
export function removeAttachment(todoId: unknown, attId: unknown): TodoItem | null {
  const list = ensureLoaded();
  const item = typeof todoId === "string" ? list.find((t) => t.id === todoId) : undefined;
  if (!item || !Array.isArray(item.attachments)) return item ? { ...item } : null;
  const idx = typeof attId === "string" ? item.attachments.findIndex((a) => a.id === attId) : -1;
  if (idx < 0) return { ...item };
  const [removed] = item.attachments.splice(idx, 1);
  if (ATTACHMENT_FILE_RE.test(removed.file)) {
    for (const dir of allAttachmentDirs()) {
      try {
        unlinkSync(join(dir, removed.file));
      } catch {
        /* not in this dir — keep looking / already gone */
      }
    }
  }
  item.attachments = item.attachments.length > 0 ? item.attachments : undefined;
  scheduleFlush();
  return { ...item };
}

/** Resolve an attachment file name to its absolute path, or null when the name
 * is malformed / outside the attachments dir (defense in depth for IPC). */
export function resolveAttachmentFile(file: unknown): string | null {
  if (typeof file !== "string" || !ATTACHMENT_FILE_RE.test(file)) return null;
  for (const dir of allAttachmentDirs()) {
    const target = join(dir, file);
    try {
      if (!existsSync(target) || !statSync(target).isFile()) continue;
    } catch {
      continue;
    }
    return target;
  }
  return null;
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
  const custom = (getConfig().todoDataDir || "").trim();
  return custom ? join(custom, "todos-inbox") : join(getConfigDir(), "todos-inbox");
}

/** Ensure the agent inbox exists at its CURRENT location and return it. */
export function ensureInboxDir(): string {
  const dir = inboxDir();
  mkdirSync(dir, { recursive: true });
  return dir;
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
