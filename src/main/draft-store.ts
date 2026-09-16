import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config";
import type { ComposerDraft, PendingQuote } from "../renderer/src/lib/types";

/**
 * Persistent composer drafts (unsent input per thread).
 *
 * Stored as a single JSON file under the app's userData dir (next to
 * config.json, so dev/prod profiles stay separated like every other setting).
 * The in-memory Map is the LRU bookkeeper: insertion order = recency. On set
 * we delete-then-insert so an updated draft moves to the MRU end and the
 * count cap evicts the LEAST recently used entry, never an active one
 * (the FIFO-truncation footgun from pi-agent-desktop #19).
 */

/** Keep at most this many drafts; older ones are evicted on insert. */
const MAX_DRAFTS = 40;
/** Per-draft persistence cap. Pasted images are base64 and can be MBs each,
 * so oversized entries are shrunk (images dropped first) before giving up. */
const MAX_ENTRY_BYTES = 2_000_000;
/** Coalesce rapid keystroke-driven writes into one disk flush. */
const FLUSH_MS = 300;

let drafts: Map<string, ComposerDraft> | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function file(): string {
  return join(getConfigDir(), "drafts.json");
}

function ensureLoaded(): Map<string, ComposerDraft> {
  if (drafts) return drafts;
  const map = new Map<string, ComposerDraft>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const d = value as Partial<ComposerDraft>;
        map.set(key, {
          text: typeof d.text === "string" ? d.text : "",
          images: Array.isArray(d.images) ? (d.images as ComposerDraft["images"]) : [],
          files: Array.isArray(d.files) ? (d.files as ComposerDraft["files"]) : [],
          htmlReferences: Array.isArray(d.htmlReferences) ? (d.htmlReferences as ComposerDraft["htmlReferences"]) : undefined,
          quotes: Array.isArray(d.quotes)
            ? (d.quotes as PendingQuote[]).filter((q) => q && typeof q.text === "string")
            : undefined,
        });
      }
    }
  } catch {
    // Missing or corrupt file -> start empty. A corrupt file is left in place
    // for inspection; the next flush overwrites it atomically.
  }
  drafts = map;
  return map;
}

/** Shrink a draft until it fits MAX_ENTRY_BYTES, or null if even the bare
 * minimum (text + file paths) does not fit — that entry stays memory-only. */
function sanitize(draft: ComposerDraft): ComposerDraft | null {
  let entry: ComposerDraft = { ...draft, images: [...(draft.images || [])], files: [...(draft.files || [])] };
  if (JSON.stringify(entry).length <= MAX_ENTRY_BYTES) return entry;

  // Drop pasted images first — they are the only multi-MB component.
  entry = { ...entry, images: [] };
  if (JSON.stringify(entry).length <= MAX_ENTRY_BYTES) return entry;

  // Then drop bulky element markup from HTML references.
  entry = {
    ...entry,
    htmlReferences: (entry.htmlReferences || []).map((r) => ({ ...r, outerHTML: undefined })),
  };
  if (JSON.stringify(entry).length <= MAX_ENTRY_BYTES) return entry;

  // Last resort: keep a bounded slice of the text so something survives.
  const text = String(entry.text || "");
  if (text.length > 200_000) {
    entry = { ...entry, text: text.slice(0, 200_000), htmlReferences: undefined };
    if (JSON.stringify(entry).length <= MAX_ENTRY_BYTES) return entry;
  }
  return null;
}

function writeNow(): void {
  const map = ensureLoaded();
  try {
    const target = file();
    const tmp = target + ".tmp";
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
    renameSync(tmp, target);
  } catch (e) {
    console.error("[drafts] persist failed:", e);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeNow();
  }, FLUSH_MS);
}

export function getAllDrafts(): Record<string, ComposerDraft> {
  return Object.fromEntries(ensureLoaded());
}

export function setDraft(key: string, draft: ComposerDraft): void {
  const map = ensureLoaded();
  // LRU refresh: re-insert at the MRU end (delete first so an existing key
  // does not keep its original position).
  map.delete(key);
  const entry = sanitize(draft);
  if (entry) map.set(key, entry);
  while (map.size > MAX_DRAFTS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  scheduleFlush();
}

export function deleteDraft(key: string): void {
  if (!ensureLoaded().delete(key)) return;
  scheduleFlush();
}

/** Synchronous final flush — call on app quit so the coalesced write cannot
 * be lost. */
export function flushDrafts(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  writeNow();
}
