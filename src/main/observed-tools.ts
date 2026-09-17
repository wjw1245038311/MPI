import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config";
import { forEachLine, getSessionsDir, listAllSessionFiles } from "./session-store";

/**
 * Registry of tool names observed in this profile's sessions. Feeds the
 * Settings → Permissions trusted-tools picker so users can toggle tools from a
 * searchable list instead of typing exact names.
 *
 * Two write paths, both owned by main (single writer — no cross-process races):
 * 1. Live: recordToolCall() from the pi event relay on every tool_execution_start.
 * 2. One-time backfill: ensureBackfilled() scans historical session .jsonl files
 *    (newest first, byte-budgeted) so the list is populated immediately after
 *    install without waiting for tools to be called again.
 *
 * The registry is convenience data — a corrupt/missing file just means an empty
 * list; it never blocks or crashes anything.
 */

export interface ObservedToolInfo {
  name: string;
  /** Epoch ms of the first live observation (null when only backfilled). */
  firstSeen: number | null;
  lastSeen: number | null;
  count: number;
}

interface Entry {
  firstSeen: number | null;
  lastSeen: number | null;
  count: number;
}

const FILE_NAME = "observed-tools.json";
/** Hard cap on distinct names (tool namespaces are small; this is a safety net). */
const MAX_ENTRIES = 500;
/** Coalesce rapid writes into one disk flush. */
const FLUSH_MS = 300;
/** Backfill budget: scan newest-first session files until this many bytes read. */
const BACKFILL_BYTE_BUDGET = 64 * 1024 * 1024;

// Only parse pi's persisted toolResult entries — a bare "toolName" regex would
// also match quoted event text inside tool outputs (false positives).
const TOOL_RESULT_NAME_RE = /"role":"toolResult","toolCallId":"[^"]*","toolName":"([^"\\]{1,80})"/;

let cache: Map<string, Entry> | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let backfillPromise: Promise<void> | null = null;

function file(): string {
  return join(getConfigDir(), FILE_NAME);
}

function ensureLoaded(): Map<string, Entry> {
  if (cache) return cache;
  const map = new Map<string, Entry>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const e = value as Partial<Entry>;
        map.set(key, {
          firstSeen: typeof e.firstSeen === "number" ? e.firstSeen : null,
          lastSeen: typeof e.lastSeen === "number" ? e.lastSeen : null,
          count: typeof e.count === "number" && e.count > 0 ? Math.trunc(e.count) : 1,
        });
      }
    }
  } catch {
    // Missing or corrupt file -> start empty; the next flush overwrites atomically.
  }
  cache = map;
  return map;
}

function writeThrough(): void {
  try {
    const obj: Record<string, Entry> = {};
    for (const [k, v] of ensureLoaded()) obj[k] = v;
    const tmp = file() + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj), "utf8");
    renameSync(tmp, file());
  } catch {
    // Convenience sidecar — never crash the app over it.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeThrough();
  }, FLUSH_MS);
  flushTimer.unref?.();
}

/** Synchronous flush for tests and clean shutdown. */
export function flushObservedTools(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  writeThrough();
}

/** Drop the least-recently-seen entry (nulls sort first). */
function dropLeastRecentlySeen(map: Map<string, Entry>): void {
  let victim: string | null = null;
  let victimSeen = Infinity;
  for (const [name, e] of map) {
    const seen = e.lastSeen ?? 0;
    if (seen < victimSeen) {
      victimSeen = seen;
      victim = name;
    }
  }
  if (victim) map.delete(victim);
}

function pruneToCap(map: Map<string, Entry>): void {
  while (map.size > MAX_ENTRIES) dropLeastRecentlySeen(map);
}

/** Record one tool execution (called from the pi event relay). */
export function recordToolCall(name: string): void {
  if (typeof name !== "string" || !name.trim()) return;
  const now = Date.now();
  const map = ensureLoaded();
  const cur = map.get(name);
  if (cur) {
    cur.count += 1;
    cur.lastSeen = now;
  } else {
    // Make room BEFORE inserting so the post-insert size stays within the cap.
    while (map.size >= MAX_ENTRIES) dropLeastRecentlySeen(map);
    map.set(name, { firstSeen: now, lastSeen: now, count: 1 });
  }
  scheduleFlush();
}

/** Current registry state (live + backfilled), sorted by name. */
export function listObservedTools(): ObservedToolInfo[] {
  const out: ObservedToolInfo[] = [];
  for (const [name, e] of ensureLoaded()) {
    out.push({ name, firstSeen: e.firstSeen, lastSeen: e.lastSeen, count: e.count });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One-time backfill from historical session files (newest first, byte-budgeted).
 * No-op once it has run in this process; safe to call at startup. Merges into
 * whatever live recording already captured — never clobbers newer entries.
 */
/** @returns the (latched) backfill promise so tests can await it. */
export function ensureBackfilled(): Promise<void> {
  if (!backfillPromise) {
    backfillPromise = runBackfill().catch((e) => console.warn("[observed-tools] backfill failed:", e));
  }
  return backfillPromise;
}

async function runBackfill(): Promise<void> {
  const map = ensureLoaded();
  let bytesRead = 0;
  try {
    const root = getSessionsDir();
    // Newest first so the byte budget covers recent history (tool sets are
    // stable across sessions — partial coverage still yields the full name set).
    const files = listAllSessionFiles(root)
      .map((path) => ({ path, mtimeMs: safeMtime(path) }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const f of files) {
      if (bytesRead >= BACKFILL_BYTE_BUDGET) break;
      bytesRead += safeSize(f.path);
      await forEachLine(f.path, (line) => {
        const m = TOOL_RESULT_NAME_RE.exec(line);
        if (!m) return;
        const name = m[1];
        const cur = map.get(name);
        if (cur) cur.count += 1;
        else map.set(name, { firstSeen: null, lastSeen: null, count: 1 });
      });
    }
  } catch {
    // Best effort — a failed scan just leaves the list smaller.
  }
  pruneToCap(map);
  writeThrough();
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Test hook: reset module state (cache + timers + backfill latch). */
export function __resetObservedToolsForTests(): void {
  cache = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  backfillPromise = null;
}

/** Test hook: whether the registry file exists on disk. */
export function observedToolsFileExists(): boolean {
  return existsSync(file());
}
