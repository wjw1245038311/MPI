import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { getConfig, getConfigDir, updateConfig, type AppConfig, type PendingDataMigration } from "./config";
import { defaultSessionsDir, getAgentDir, getSessionsDir, listAllSessionFiles } from "./session-store";
import { getTrashDir } from "./trash-store";
import { allAttachmentDirs, inboxDir, todosFilePath } from "./todo-store";
import { remapDrafts } from "./draft-store";

/**
 * Data-location migrations (Settings → 数据管理). The user picks a new home for
 * the session JSONL files and/or the todo data; Settings records a pending
 * migration in config.json and the actual file moves happen on the NEXT launch
 * (runPendingDataMigrations), because running pi processes must not hold open
 * session files mid-move.
 *
 * Sessions: every .jsonl is moved into the target dir (flat layout — pi's own
 * `sessionDir` setting always writes flat). Path-keyed references elsewhere
 * (thread permissions, drafts, trash index, todo source links) are remapped to
 * the new locations, and pi's settings.json gets a `sessionDir` key so terminal
 * pi follows along too. Restoring the default layout moves files back into
 * per-project subdirectories using each file's header cwd.
 *
 * Todos: todos.json + attachment files + pending inbox files are moved into
 * <target>/todos.json, <target>/todo-attachments/ and <target>/todos-inbox/.
 */

export interface MigrationSummary {
  sessionsMoved?: number;
  sessionBytes?: number;
  todoFilesMoved?: number;
  todoBytes?: number;
  /** Human-readable problems (file locks, missing dirs…). Empty when clean. */
  errors: string[];
}

let lastMigrationSummary: MigrationSummary | null = null;

export function getLastMigrationSummary(): MigrationSummary | null {
  return lastMigrationSummary;
}

// ---------------------------------------------------------------------------
// File moving helpers (pure enough to unit-test)
// ---------------------------------------------------------------------------

/** Target path that never clobbers an existing file: name.json -> name-1.json. */
export function uniqueTarget(toDir: string, fileName: string): string {
  const target = join(toDir, fileName);
  if (!existsSync(target)) return target;
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = join(toDir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

export interface FileMovePlan {
  from: string;
  to: string;
  bytes: number;
}

/** Move a list of files (mkdir parents as needed). rename first, copy+unlink
 * fallback for cross-device moves. Returns per-file failures instead of
 * throwing — one locked file must not abort the whole migration. */
export function moveFiles(plan: FileMovePlan[]): { moved: number; failed: string[] } {
  const failed: string[] = [];
  let moved = 0;
  for (const p of plan) {
    try {
      if (!existsSync(p.from)) continue; // vanished since planning — fine
      mkdirSync(resolve(p.to, ".."), { recursive: true });
      try {
        renameSync(p.from, p.to);
      } catch (e: any) {
        if (e?.code === "EXDEV") {
          writeFileSync(p.to, readFileSync(p.from));
          unlinkSync(p.from);
        } else {
          throw e;
        }
      }
      moved++;
    } catch (e: any) {
      failed.push(`${basename(p.from)}: ${String(e?.message || e)}`);
    }
  }
  return { moved, failed };
}

/** Read the `cwd` from a session file's header line, or null when absent. */
export function readHeaderCwd(file: string): string | null {
  try {
    const first = readFileSync(file, "utf8").split("\n", 1)[0];
    if (!first.trim()) return null;
    const entry = JSON.parse(first);
    return typeof entry?.cwd === "string" && entry.cwd ? entry.cwd : null;
  } catch {
    return null;
  }
}

/** pi's per-project directory name encoding (see getDefaultSessionDirPath in
 * the pi bundle): `--<cwd with / \ : replaced by ->-`. */
export function safeProjectDir(cwd: string): string {
  const resolved = resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

// ---------------------------------------------------------------------------
// pi settings.json (sessionDir key) — shared by terminal pi and MPI-spawned pi
// ---------------------------------------------------------------------------

export function getPiSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

/** Read pi's global settings. Returns null when the file exists but is not
 * valid JSON — callers must NOT overwrite a corrupt user file silently. */
function readPiSettings(): Record<string, unknown> | null {
  const p = getPiSettingsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Set (or remove when dir=null) the `sessionDir` key in pi's settings.json.
 * Throws on a corrupt existing file — migration must not clobber user config. */
export function setPiSessionDir(dir: string | null): void {
  const current = readPiSettings();
  if (!current) throw new Error(`pi settings unreadable: ${getPiSettingsPath()}`);
  if (dir === null) delete current.sessionDir;
  else current.sessionDir = dir;
  writeFileSync(getPiSettingsPath(), JSON.stringify(current, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Path-reference remapping: every store that keys on session file paths must
// follow the files when they move. All raw-JSON edits are idempotent (a no-op
// replacement is harmless) so a retried migration stays safe.
// ---------------------------------------------------------------------------

/** Returns the number of keys remapped (0 when nothing matched). */
function remapJsonFileKeys(file: string, map: Map<string, string>): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return 0; // missing/corrupt — nothing to remap
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  const obj = parsed as Record<string, unknown>;
  let changed = 0;
  for (const [k, v] of Object.entries(obj)) {
    const nk = map.get(k);
    if (nk && nk !== k) {
      delete obj[k];
      obj[nk] = v;
      changed++;
    }
  }
  if (changed > 0) writeFileSync(file, JSON.stringify(obj), "utf8");
  return changed;
}

/** Returns the number of values remapped (0 when nothing matched). */
function remapJsonFileValues(
  file: string,
  map: Map<string, string>,
  pick: (entry: Record<string, unknown>) => string | undefined,
  set: (entry: Record<string, unknown>, value: string) => void,
): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return 0;
  }
  const entries: Record<string, unknown>[] = Array.isArray(parsed) ? (parsed as any[]) : [parsed as Record<string, unknown>];
  let changed = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const v = pick(entry);
    if (typeof v === "string") {
      const nv = map.get(v);
      if (nv && nv !== v) {
        set(entry, nv);
        changed++;
      }
    }
  }
  if (changed > 0) writeFileSync(file, JSON.stringify(parsed), "utf8");
  return changed;
}

/** Remap session-file path references in every MPI-owned store. */
function remapSessionReferences(map: Map<string, string>): void {
  const cfg = getConfig();
  // threadPermissions is keyed by session file path — rebuild via updateConfig
  // so the change lands atomically with the pending-migration cleanup later.
  if (cfg.threadPermissions && Object.keys(cfg.threadPermissions).length > 0) {
    const next: Record<string, (typeof cfg.threadPermissions)[string]> = {};
    for (const [k, v] of Object.entries(cfg.threadPermissions)) next[map.get(k) || k] = v;
    updateConfig({ threadPermissions: next });
  }
  // drafts.json keys look like "s:<sessionFile>" / "n:<cwd>".
  remapJsonFileKeys(join(getConfigDir(), "drafts.json"), new Map([...map].map(([k, v]) => [`s:${k}`, `s:${v}`])));
  // trash index entries remember the original file location.
  remapJsonFileValues(
    join(getTrashDir(), "index.json"),
    map,
    (e) => (typeof e.originalFile === "string" ? e.originalFile : undefined),
    (e, v) => {
      e.originalFile = v;
    },
  );
  // Agent-sourced todos link back to the session they came from.
  remapJsonFileValues(
    todosFilePath(),
    map,
    (e) => (typeof e.sessionFile === "string" ? e.sessionFile : undefined),
    (e, v) => {
      e.sessionFile = v;
    },
  );
}

// ---------------------------------------------------------------------------
// Planning (Settings UI: show count/bytes before the user confirms)
// ---------------------------------------------------------------------------

export interface MigrationPlan {
  files: FileMovePlan[];
  count: number;
  bytes: number;
}

/** Plan moving every session file from MPI's current effective location to
 * `toDir` (flat). */
export function planSessionMigration(toDir: string): MigrationPlan {
  const from = getSessionsDir();
  if (resolve(from) === resolve(toDir)) return { files: [], count: 0, bytes: 0 };
  const files: FileMovePlan[] = listAllSessionFiles(from).map((f) => ({
    from: f,
    to: uniqueTarget(toDir, basename(f)),
    bytes: safeSize(f),
  }));
  return { files, count: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) };
}

/** Plan moving all todo data into `toDir`'s standard sub-layout. */
/** True when `file` already lives inside `toDir` — picking a folder that
 * holds (part of) the current data must not plan self-moves. */
function isInside(file: string, toDir: string): boolean {
  const root = resolve(toDir);
  const p = resolve(file);
  return p === root || p.startsWith(root + sep);
}

export function planTodoMigration(toDir: string): MigrationPlan {
  const files: FileMovePlan[] = [];
  const todosFile = todosFilePath();
  if (existsSync(todosFile) && !isInside(todosFile, toDir)) {
    files.push({ from: todosFile, to: join(toDir, "todos.json"), bytes: safeSize(todosFile) });
  }
  for (const dir of allAttachmentDirs()) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      const p = join(dir, f);
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      if (isInside(p, toDir)) continue;
      files.push({ from: p, to: uniqueTarget(join(toDir, "todo-attachments"), f), bytes: safeSize(p) });
    }
  }
  let inboxEntries: string[] = [];
  try {
    inboxEntries = readdirSync(inboxDir());
  } catch {
    /* no inbox yet */
  }
  for (const f of inboxEntries) {
    if (!f.endsWith(".json")) continue;
    const p = join(inboxDir(), f);
    if (isInside(p, toDir)) continue;
    files.push({ from: p, to: uniqueTarget(join(toDir, "todos-inbox"), f), bytes: safeSize(p) });
  }
  return { files, count: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) };
}

function safeSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Execution (next launch)
// ---------------------------------------------------------------------------

/** Apply the pending migration recorded in config. Returns null when there is
 * nothing to do. Successful parts are cleared from the pending record; failed
 * parts stay for a retry on the following launch. */
export function runPendingDataMigrations(): MigrationSummary | null {
  const cfg = getConfig();
  const pending = cfg.pendingDataMigration;
  if (!pending) return null;

  const summary: MigrationSummary = { errors: [] };
  const remaining: PendingDataMigration = {};

  if (pending.sessions) {
    const r = runSessionMigration(pending.sessions);
    summary.sessionsMoved = r.moved;
    summary.sessionBytes = r.bytes;
    summary.errors.push(...r.failed.map((f) => `sessions: ${f}`));
    if (!r.ok) remaining.sessions = pending.sessions; // retry next launch
  }

  if (pending.todos) {
    const r = runTodoMigration(pending.todos);
    summary.todoFilesMoved = r.moved;
    summary.todoBytes = r.bytes;
    summary.errors.push(...r.failed.map((f) => `todos: ${f}`));
    if (!r.ok) remaining.todos = pending.todos;
  }

  lastMigrationSummary = summary;
  updateConfig({ pendingDataMigration: remaining.sessions || remaining.todos ? remaining : undefined });
  return summary;
}

interface PartResult {
  ok: boolean;
  moved: number;
  bytes: number;
  failed: string[];
}

function runSessionMigration(pending: NonNullable<PendingDataMigration["sessions"]>): PartResult {
  const { fromDir, toDir } = pending;
  const restoreDefault = resolve(toDir) === resolve(getSessionsDir()) && !getConfig().sessionStorageDir;
  const plan: FileMovePlan[] = [];

  const skippedNoCwd: string[] = [];
  if (restoreDefault) {
    // Back into per-project subdirectories using each file's header cwd.
    for (const f of listAllSessionFiles(fromDir)) {
      const cwd = readHeaderCwd(f);
      if (!cwd) {
        skippedNoCwd.push(`${basename(f)} (no cwd header — left in place)`);
        continue;
      }
      plan.push({ from: f, to: join(toDir, safeProjectDir(cwd), basename(f)), bytes: safeSize(f) });
    }
  } else {
    for (const f of listAllSessionFiles(fromDir)) {
      plan.push({ from: f, to: uniqueTarget(toDir, basename(f)), bytes: safeSize(f) });
    }
  }

  const map = new Map<string, string>(); // old path -> new path (for ref remap)
  let movedBytes = 0;
  let movedCount = 0;
  const failed: string[] = [...skippedNoCwd];
  if (plan.length > 0) {
    mkdirSync(toDir, { recursive: true });
    for (const p of plan) map.set(resolve(p.from), resolve(p.to));
    const res = moveFiles(plan);
    movedCount = res.moved;
    movedBytes = plan.reduce((s, p) => s + p.bytes, 0);
    failed.push(...res.failed);
  }

  // pi's settings.json follows the new location (terminal pi included).
  try {
    setPiSessionDir(restoreDefault ? null : toDir);
  } catch (e: any) {
    // Files moved but pi still points at the old dir — keep the pending
    // record so the next launch retries; surface a clear error.
    return { ok: false, moved: movedCount, bytes: movedBytes, failed: [...failed, `settings.json: ${String(e?.message || e)}`] };
  }

  if (map.size > 0) remapSessionReferences(map);
  // "left in place" notes are informational; only real move errors retry.
  const hardFailures = failed.filter((f) => !f.includes("left in place") && !f.startsWith("settings.json:"));
  return { ok: hardFailures.length === 0, moved: movedCount, bytes: movedBytes, failed };
}

function runTodoMigration(pending: NonNullable<PendingDataMigration["todos"]>): PartResult {
  const { toDir, fromTodosFile, fromAttachmentDirs, fromInbox } = pending;
  const plan: FileMovePlan[] = [];

  if (existsSync(fromTodosFile)) {
    // Refusing to clobber an existing todos.json in the target — pick another
    // folder or merge manually. The file stays where it is and the pending
    // record retries next launch (still failing, but visible in the toast).
    if (existsSync(join(toDir, "todos.json"))) {
      return { ok: false, moved: 0, bytes: 0, failed: ["target already contains todos.json — choose a different folder"] };
    }
    plan.push({ from: fromTodosFile, to: join(toDir, "todos.json"), bytes: safeSize(fromTodosFile) });
  }

  for (const dir of fromAttachmentDirs) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      const p = join(dir, f);
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      if (isInside(p, toDir)) continue; // already in the target layout
      plan.push({ from: p, to: uniqueTarget(join(toDir, "todo-attachments"), f), bytes: safeSize(p) });
    }
  }

  let inboxEntries: string[] = [];
  try {
    inboxEntries = readdirSync(fromInbox);
  } catch {
    /* no inbox */
  }
  for (const f of inboxEntries) {
    if (!f.endsWith(".json")) continue;
    const p = join(fromInbox, f);
    if (isInside(p, toDir)) continue; // already in the target layout
    plan.push({ from: p, to: uniqueTarget(join(toDir, "todos-inbox"), f), bytes: safeSize(p) });
  }

  const res = moveFiles(plan);
  // The legacy attachment-dir override is stale once everything moved cleanly.
  if (res.failed.length === 0) updateConfig({ todoAttachmentDir: undefined });
  return { ok: res.failed.length === 0, moved: res.moved, bytes: plan.reduce((s, p) => s + p.bytes, 0), failed: res.failed };
}

// ---------------------------------------------------------------------------
// IPC facade (Settings → 数据管理)
// ---------------------------------------------------------------------------

export interface DataMigrationStatus {
  /** Currently configured custom session dir, or null. */
  sessionStorageDir: string | null;
  /** pi's built-in location, for the "restore default" affordance. */
  defaultSessionsDir: string;
  /** Effective sessions dir right now (custom when set). */
  effectiveSessionsDir: string;
  todoDataDir: string | null;
  /** Effective todo data dir right now (built-in home when unset). */
  effectiveTodosDir: string;
  pendingSessions: boolean;
  pendingTodos: boolean;
  lastSummary: MigrationSummary | null;
}

export function getDataMigrationStatus(): DataMigrationStatus {
  const cfg = getConfig();
  return {
    sessionStorageDir: cfg.sessionStorageDir || null,
    defaultSessionsDir: defaultSessionsDir(),
    effectiveSessionsDir: getSessionsDir(),
    todoDataDir: cfg.todoDataDir || null,
    effectiveTodosDir: (cfg.todoDataDir || "").trim() ? resolve((cfg.todoDataDir as string).trim()) : getConfigDir(),
    pendingSessions: Boolean(cfg.pendingDataMigration?.sessions),
    pendingTodos: Boolean(cfg.pendingDataMigration?.todos),
    lastSummary: getLastMigrationSummary(),
  };
}

/** Validate a user-picked folder. Returns an error string or null when OK. */
export function validateTargetDir(dir: unknown): string | null {
  if (typeof dir !== "string" || !dir.trim()) return "empty";
  const raw = dir.trim();
  // Check the RAW input for absoluteness — resolve() would silently anchor a
  // relative path to the main process cwd.
  if (!raw.startsWith(sep) && !/^[A-Za-z]:[\\/]/.test(raw)) return "not-absolute";
  const p = resolve(raw);
  // Refusing to point the store at MPI's own config home would make a
  // migration move files into the very dir that holds config.json — legal but
  // confusing, so keep it out of reach from the picker flow.
  if (resolve(p) === resolve(getConfigDir())) return "is-config-dir";
  return null;
}

export interface SetResult {
  ok: boolean;
  error?: string;
  /** True when a file move is queued for next launch. */
  pending: boolean;
  count: number;
  bytes: number;
}

/** Point the session store at `dir` (null = restore pi's default layout).
 * Records a pending migration; files actually move on next launch. */
export function setSessionsDir(dir: unknown): SetResult {
  const cfg = getConfig();
  if (dir === null || dir === undefined || String(dir).trim() === "") {
    // Restore default. No-op when already at the default with no pending work.
    const toDir = defaultSessionsDir();
    const fromDir = getSessionsDir();
    if (!cfg.sessionStorageDir && !cfg.pendingDataMigration?.sessions) {
      return { ok: true, pending: false, count: 0, bytes: 0 };
    }
    updateConfig({
      sessionStorageDir: undefined,
      pendingDataMigration: { ...cfg.pendingDataMigration, sessions: { fromDir, toDir } },
    });
    const plan = listAllSessionFiles(fromDir);
    return { ok: true, pending: true, count: plan.length, bytes: plan.reduce((s, f) => s + safeSize(f), 0) };
  }

  const err = validateTargetDir(dir);
  if (err) return { ok: false, error: err, pending: false, count: 0, bytes: 0 };
  const toDir = resolve(String(dir).trim());
  const fromDir = getSessionsDir();
  if (resolve(fromDir) === toDir && !cfg.pendingDataMigration?.sessions) {
    return { ok: true, pending: false, count: 0, bytes: 0 }; // already there
  }
  updateConfig({
    sessionStorageDir: toDir,
    pendingDataMigration: { ...cfg.pendingDataMigration, sessions: { fromDir, toDir } },
  });
  const plan = listAllSessionFiles(fromDir);
  return { ok: true, pending: true, count: plan.length, bytes: plan.reduce((s, f) => s + safeSize(f), 0) };
}

/** Point the todo data (todos.json + attachments + inbox) at `dir`
 * (null = restore built-in locations). */
export function setTodosDir(dir: unknown): SetResult {
  const cfg = getConfig();
  if (dir === null || dir === undefined || String(dir).trim() === "") {
    if (!cfg.todoDataDir && !cfg.pendingDataMigration?.todos) {
      return { ok: true, pending: false, count: 0, bytes: 0 };
    }
    const toDir = getConfigDir(); // built-in home for todos.json & co.
    // Plan BEFORE the config switch — after it, "current" locations resolve
    // inside the target and the plan would undercount (todos.json/inbox).
    const plan = planTodoMigration(toDir);
    updateConfig({
      todoDataDir: undefined,
      pendingDataMigration: {
        ...cfg.pendingDataMigration,
        todos: {
          toDir,
          fromTodosFile: todosFilePath(),
          fromAttachmentDirs: allAttachmentDirs(),
          fromInbox: inboxDir(),
        },
      },
    });
    return { ok: true, pending: true, count: plan.count, bytes: plan.bytes };
  }

  const err = validateTargetDir(dir);
  if (err) return { ok: false, error: err, pending: false, count: 0, bytes: 0 };
  const toDir = resolve(String(dir).trim());
  // Plan BEFORE the config switch — after it, todosFilePath()/inboxDir() and
  // allAttachmentDirs() resolve inside the target and the plan undercounts.
  const plan = planTodoMigration(toDir);
  if (!cfg.todoDataDir && !cfg.pendingDataMigration?.todos) {
    // Fresh custom dir with no data yet? Still record a (possibly empty) move
    // so the standard sub-layout gets created on next launch.
  }
  updateConfig({
    todoDataDir: toDir,
    pendingDataMigration: {
      ...cfg.pendingDataMigration,
      todos: {
        toDir,
        fromTodosFile: todosFilePath(),
        fromAttachmentDirs: allAttachmentDirs(),
        fromInbox: inboxDir(),
      },
    },
  });
  return { ok: true, pending: true, count: plan.count, bytes: plan.bytes };
}

/** Preview how many files/bytes a move would touch (Settings confirmation). */
export function previewMigration(kind: "sessions" | "todos", dir: unknown): SetResult & { error?: string } {
  if (kind === "sessions") {
    const toDir = dir == null || String(dir).trim() === "" ? defaultSessionsDir() : resolve(String(dir).trim());
    const plan = planSessionMigration(toDir);
    return { ok: true, pending: false, count: plan.count, bytes: plan.bytes };
  }
  const toDir = dir == null || String(dir).trim() === "" ? getConfigDir() : resolve(String(dir).trim());
  const plan = planTodoMigration(toDir);
  return { ok: true, pending: false, count: plan.count, bytes: plan.bytes };
}

// ---------------------------------------------------------------------------
// Project path remap (sidebar → right-click project → “更新项目路径…”).
// The user moved a project folder OUTSIDE of MPI; this re-points every app
// store at the new location immediately. Unlike data-location migrations it
// runs live, not on next launch: the old folder is gone by definition, so no
// healthy pi process can still be holding its session files (the IPC layer
// additionally refuses while a thread/automation bridge for that cwd is up).
// ---------------------------------------------------------------------------

export interface ProjectRemapResult {
  ok: boolean;
  /** Machine-readable error code when !ok (invalid-args | same-path |
   * target-not-dir | target-sessions-dir-exists | rename-failed…). */
  error?: string;
  /** Session files that physically moved (per-project dir renamed). */
  sessionsMoved: number;
  /** .jsonl session header lines whose cwd was rewritten. */
  headersUpdated: number;
  /** Config/drafts/trash/todo references re-pointed. */
  refsUpdated: number;
  /** Session dir rename actually performed (absent for flat layout). Lets the
   * renderer re-point its own path-keyed state (e.g. last-active thread). */
  sessionsFromDir?: string;
  sessionsToDir?: string;
  /** Per-file problems (locked files…). Empty when clean. */
  errors: string[];
}

/** Rewrite the `cwd` field of every session header line in one .jsonl file.
 * Only lines that parse as a `type:"session"` entry are touched — message
 * content mentioning the old path is history and stays untouched. Returns the
 * number of rewritten lines (0 = no write). */
export function rewriteSessionHeaderCwd(file: string, oldCwd: string, newCwd: string): number {
  const oldKey = resolve(oldCwd).toLowerCase();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return 0; // vanished/unreadable — caller reports
  }
  const lines = raw.split("\n");
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Cheap pre-filter: session entries start with {"type":"session" — but the
    // header is always line 1, so parse it even if key order ever differs.
    if (i !== 0 && !line.startsWith('{"type":"session"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // not JSON — leave the line alone
    }
    if (!entry || typeof entry !== "object" || entry.type !== "session") continue;
    if (typeof entry.cwd !== "string" || resolve(entry.cwd).toLowerCase() !== oldKey) continue;
    entry.cwd = newCwd;
    lines[i] = JSON.stringify(entry);
    changed++;
  }
  if (changed > 0) writeFileSync(file, lines.join("\n"), "utf8");
  return changed;
}

/** Re-point every MPI-owned store that keys on this project's old cwd and/or
 * its (moved) session file paths. Returns how many references changed. */
function remapProjectReferences(oldCwd: string, newCwd: string, fileMap: Map<string, string>): number {
  const oldKey = resolve(oldCwd).toLowerCase();
  let n = 0;

  // --- config.json (one atomic updateConfig) -------------------------------
  const cfg = getConfig();
  const patch: Partial<AppConfig> = {};
  const remapPathList = (list?: string[]): string[] | undefined => {
    if (!Array.isArray(list)) return list;
    let touched = false;
    const next = list.map((p) => {
      if (typeof p === "string" && resolve(p).toLowerCase() === oldKey) {
        n++;
        touched = true;
        return newCwd;
      }
      return p;
    });
    return touched ? next : undefined;
  };
  const pinnedProjects = remapPathList(cfg.pinnedProjects);
  if (pinnedProjects) patch.pinnedProjects = pinnedProjects;
  const archivedProjects = remapPathList(cfg.archivedProjects);
  if (archivedProjects) patch.archivedProjects = archivedProjects;
  if (typeof cfg.lastThreadCwd === "string" && resolve(cfg.lastThreadCwd).toLowerCase() === oldKey) {
    patch.lastThreadCwd = newCwd;
    n++;
  }
  if (Array.isArray(cfg.automationTasks)) {
    let touched = false;
    const next = cfg.automationTasks.map((t) => {
      if (typeof t.cwd === "string" && resolve(t.cwd).toLowerCase() === oldKey) {
        n++;
        touched = true;
        return { ...t, cwd: newCwd };
      }
      return t;
    });
    if (touched) patch.automationTasks = next;
  }

  // File-path-keyed fields only matter when the session files actually moved.
  if (fileMap.size > 0) {
    const remapFileList = (list?: string[]): string[] | undefined => {
      if (!Array.isArray(list)) return list;
      let touched = false;
      const next = list.map((p) => {
        if (typeof p !== "string") return p;
        const np = fileMap.get(resolve(p));
        if (np && np !== p) {
          n++;
          touched = true;
          return np;
        }
        return p;
      });
      return touched ? next : undefined;
    };
    const pinnedThreads = remapFileList(cfg.pinnedThreads);
    if (pinnedThreads) patch.pinnedThreads = pinnedThreads;
    if (Array.isArray(cfg.archivedThreads) && cfg.archivedThreads.length > 0) {
      let touched = false;
      const next = cfg.archivedThreads.map((t) => {
        const nf = typeof t.file === "string" ? fileMap.get(resolve(t.file)) : undefined;
        const nc = typeof t.cwd === "string" && resolve(t.cwd).toLowerCase() === oldKey ? newCwd : t.cwd;
        if (nf || nc !== t.cwd) {
          n++;
          touched = true;
          return { ...t, ...(nf ? { file: nf } : {}), ...(nc !== t.cwd ? { cwd: nc } : {}) };
        }
        return t;
      });
      if (touched) patch.archivedThreads = next;
    }
    if (cfg.threadPermissions && Object.keys(cfg.threadPermissions).length > 0) {
      let touched = false;
      const next: Record<string, (typeof cfg.threadPermissions)[string]> = {};
      for (const [k, v] of Object.entries(cfg.threadPermissions)) {
        const nk = fileMap.get(resolve(k));
        if (nk && nk !== k) {
          n++;
          touched = true;
        }
        next[nk || k] = v;
      }
      if (touched) patch.threadPermissions = next;
    }
  }

  if (Object.keys(patch).length > 0) updateConfig(patch);

  // --- drafts (memory + disk via the store — a raw on-disk edit would be
  // clobbered by the next coalesced flush) ------------------------------------
  n += remapDrafts(oldCwd, newCwd, fileMap);

  // --- trash index + agent-sourced todos (session-file links) ---------------
  if (fileMap.size > 0) {
    n += remapJsonFileValues(
      join(getTrashDir(), "index.json"),
      fileMap,
      (e) => (typeof e.originalFile === "string" ? e.originalFile : undefined),
      (e, v) => {
        e.originalFile = v;
      },
    );
    n += remapJsonFileValues(
      todosFilePath(),
      fileMap,
      (e) => (typeof e.sessionFile === "string" ? e.sessionFile : undefined),
      (e, v) => {
        e.sessionFile = v;
      },
    );
  }

  return n;
}

/** Re-point one project from `oldCwd` to `newCwd`: rename its session dir,
 * rewrite the .jsonl header cwds, and remap every path-keyed reference.
 * Synchronous; safe to retry (every step is idempotent). */
export function remapProjectPath(oldCwdRaw: unknown, newCwdRaw: unknown): ProjectRemapResult {
  const base: ProjectRemapResult = { ok: false, sessionsMoved: 0, headersUpdated: 0, refsUpdated: 0, errors: [] };
  if (
    typeof oldCwdRaw !== "string" ||
    typeof newCwdRaw !== "string" ||
    !oldCwdRaw.trim() ||
    !newCwdRaw.trim()
  ) {
    return { ...base, error: "invalid-args" };
  }
  const oldCwd = resolve(oldCwdRaw.trim());
  const newCwd = resolve(newCwdRaw.trim());
  if (oldCwd.toLowerCase() === newCwd.toLowerCase()) return { ...base, error: "same-path" };
  if (!existsSync(newCwd) || !statSync(newCwd).isDirectory()) return { ...base, error: "target-not-dir" };

  const errors: string[] = [];
  const fileMap = new Map<string, string>(); // old session-file path -> new (only when moved)

  // --- locate the project's session files -----------------------------------
  const root = getSessionsDir();
  const fromDir = join(root, safeProjectDir(oldCwd));
  let targetDir: string | null = null; // dir holding the files after a rename
  let moved = false;
  if (existsSync(fromDir) && statSync(fromDir).isDirectory()) {
    const toDir = join(root, safeProjectDir(newCwd));
    if (toDir.toLowerCase() !== fromDir.toLowerCase()) {
      if (existsSync(toDir)) {
        // Refusing a non-empty target avoids clobbering another project's
        // history; an empty leftover dir can simply be cleared.
        let empty = true;
        try {
          if (readdirSync(toDir).length > 0) empty = false;
        } catch {
          empty = false; // unreadable — treat as non-empty
        }
        if (!empty) return { ...base, error: "target-sessions-dir-exists" };
        rmdirSync(toDir);
      }
      try {
        renameSync(fromDir, toDir);
      } catch (e: any) {
        return { ...base, error: `rename-failed: ${String(e?.message || e)}` };
      }
      targetDir = toDir;
      moved = true;
    } else {
      targetDir = fromDir;
    }
  }

  // --- collect candidates ----------------------------------------------------
  const candidates: string[] = [];
  if (targetDir) {
    try {
      for (const f of readdirSync(targetDir)) if (f.endsWith(".jsonl")) candidates.push(join(targetDir, f));
    } catch (e: any) {
      errors.push(`read dir: ${String(e?.message || e)}`);
    }
  } else {
    // Flat layout (custom session dir) or no per-project subdir at all: pick
    // files by their header cwd.
    for (const f of listAllSessionFiles(root)) {
      const c = readHeaderCwd(f);
      if (c && resolve(c).toLowerCase() === oldCwd.toLowerCase()) candidates.push(f);
    }
  }

  // The rename already happened — register every file's new location for the
  // reference remap even if its header rewrite later fails.
  if (moved) {
    for (const f of candidates) {
      fileMap.set(resolve(join(fromDir, basename(f))), resolve(join(targetDir as string, basename(f))));
    }
  }

  let headersUpdated = 0;
  for (const f of candidates) {
    try {
      headersUpdated += rewriteSessionHeaderCwd(f, oldCwd, newCwd);
    } catch (e: any) {
      errors.push(`${basename(f)}: ${String(e?.message || e)}`);
    }
  }

  const refsUpdated = remapProjectReferences(oldCwd, newCwd, fileMap);

  return {
    ok: errors.length === 0,
    sessionsMoved: fileMap.size,
    headersUpdated,
    refsUpdated,
    ...(moved && targetDir ? { sessionsFromDir: fromDir, sessionsToDir: targetDir } : {}),
    errors,
  };
}
