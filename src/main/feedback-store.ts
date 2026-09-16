import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config";

/**
 * Per-message user feedback (👍/👎 + optional note) for assistant replies.
 *
 * Keyed by the stable pi session entry id (ULID), which is globally unique —
 * no need to prefix with the session file. Stored as a plain JSON sidecar
 * under userData; it NEVER enters the model context or any prompt, so it is
 * safe to write on every click.
 */

export interface FeedbackEntry {
  /** 1 = helpful (👍), -1 = not helpful (👎). */
  rating: 1 | -1;
  note?: string;
  at: number;
}

export type FeedbackMap = Record<string, FeedbackEntry>;

const MAX_NOTE_CHARS = 500;
/** Coalesce rapid writes into one disk flush. */
const FLUSH_MS = 300;

let cache: Map<string, FeedbackEntry> | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function file(): string {
  return join(getConfigDir(), "feedback.json");
}

function ensureLoaded(): Map<string, FeedbackEntry> {
  if (cache) return cache;
  const map = new Map<string, FeedbackEntry>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const e = value as Partial<FeedbackEntry>;
        if (e.rating !== 1 && e.rating !== -1) continue;
        map.set(key, {
          rating: e.rating,
          note: typeof e.note === "string" && e.note.trim() ? e.note.slice(0, MAX_NOTE_CHARS) : undefined,
          at: typeof e.at === "number" ? e.at : Date.now(),
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
    const obj: FeedbackMap = {};
    for (const [k, v] of ensureLoaded()) obj[k] = v;
    const tmp = file() + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj), "utf8");
    renameSync(tmp, file());
  } catch {
    // Feedback is a convenience sidecar — never crash the app over it.
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
export function flushFeedback(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  writeThrough();
}

export function getFeedback(): FeedbackMap {
  const obj: FeedbackMap = {};
  for (const [k, v] of ensureLoaded()) obj[k] = v;
  return obj;
}

/** Set or update a rating. note === undefined keeps the existing note,
 * null clears it, a string replaces it (trimmed; empty -> cleared). */
export function setFeedback(entryId: string, rating: 1 | -1, note?: string | null): FeedbackEntry {
  const map = ensureLoaded();
  let nextNote: string | undefined;
  if (note === undefined) nextNote = map.get(entryId)?.note;
  else if (note !== null) nextNote = note.trim().slice(0, MAX_NOTE_CHARS) || undefined;
  const entry: FeedbackEntry = { rating, note: nextNote, at: Date.now() };
  map.set(entryId, entry);
  scheduleFlush();
  return entry;
}

/** Re-clicking the active rating retracts it (dsh parity). */
export function deleteFeedback(entryId: string): void {
  if (!ensureLoaded().delete(entryId)) return;
  scheduleFlush();
}
