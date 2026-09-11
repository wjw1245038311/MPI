/**
 * Tails the JSONL progress file written by scripts/publish-release.mjs during
 * GitHub Release asset uploads, feeding it into transfer-monitor so the
 * renderer's long-task monitor shows real upload bytes/speed for dev releases.
 *
 * Why a file bridge: in the two-stage release flow the pipeline runs as a CLI
 * process (node scripts/dev-release.mjs) OUTSIDE this app — there is no IPC
 * channel to hook, so publish-release.mjs appends one JSON object per line to
 * %TEMP%/mpi-dev-release-progress.jsonl and we poll it here. Dev mode only:
 * index.ts calls startDevReleaseProgressTail() when !app.isPackaged.
 *
 * Protocol (one JSON object per line; see scripts/publish-release.mjs):
 *   { run, op:"begin",  id, label, totalBytes }
 *   { run, op:"update", id, doneBytes, speedBps }
 *   { run, op:"end",    id }
 *   { run, op:"done" }                       ← script finished (success or fail)
 * The writer truncates the file at run start and unlinks it on exit. A shrunken
 * file, a missing file, a new `run` id, or 30s of silence with live entries all
 * mean "writer gone" → drop bridge-owned entries.
 */

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginTransfer, endTransfer, updateTransfer } from "./transfer-monitor";

/** Same file the writer (scripts/publish-release.mjs) appends to. */
export const PROGRESS_FILE =
  process.env.MPI_RELEASE_PROGRESS_FILE || path.join(os.tmpdir(), "mpi-dev-release-progress.jsonl");

const POLL_MS = 1000;
/** No lines for this long while entries are live → writer crashed/killed mid-upload. */
const STALE_AFTER_MS = 30_000;

export interface ProgressLine {
  run?: number;
  op?: string;
  id?: string;
  label?: string;
  totalBytes?: number;
  doneBytes?: number;
  speedBps?: number;
}

/** Mutable tailer state (one per running app). */
export interface BridgeState {
  /** run id of the lines currently being consumed. */
  runId: number;
  /** Bytes already consumed from PROGRESS_FILE for the current file incarnation. */
  offset: number;
  /** Timestamp of the last line seen (any op); drives stale detection. */
  lastActivityAt: number;
  /** Asset id → transfer-monitor entry id (bridge-owned entries only). */
  ids: Map<string, string>;
}

export function newBridgeState(): BridgeState {
  return { runId: 0, offset: 0, lastActivityAt: 0, ids: new Map() };
}

/** Drop all bridge-owned transfer entries. */
function dropAll(st: BridgeState): void {
  for (const tid of st.ids.values()) endTransfer(tid);
  st.ids.clear();
}

/**
 * Apply one parsed progress line to the state, creating/updating/ending
 * transfer-monitor entries. Exported pure-ish (takes `now`) for tests.
 */
export function applyProgressLine(st: BridgeState, line: ProgressLine, now = Date.now()): void {
  if (typeof line.run !== "number" || typeof line.op !== "string") return;
  st.lastActivityAt = now;
  if (line.run !== st.runId) {
    // New pipeline run started (writer truncated the file): drop leftovers.
    dropAll(st);
    st.runId = line.run;
  }
  switch (line.op) {
    case "begin": {
      if (!line.id || !line.label) return;
      const prev = st.ids.get(line.id);
      // Same asset id again = retry after a failed attempt (e.g. 422 → delete → re-upload).
      if (prev) endTransfer(prev);
      const tid = beginTransfer({
        kind: "upload",
        label: line.label,
        ...(line.totalBytes ? { totalBytes: line.totalBytes } : {}),
      });
      st.ids.set(line.id, tid);
      return;
    }
    case "update": {
      const tid = line.id ? st.ids.get(line.id) : undefined;
      if (!tid) return;
      updateTransfer(tid, {
        ...(line.doneBytes !== undefined ? { doneBytes: line.doneBytes } : {}),
        ...(line.speedBps !== undefined ? { speedBps: line.speedBps } : {}),
      });
      return;
    }
    case "end": {
      if (!line.id) return;
      const tid = st.ids.get(line.id);
      if (tid) {
        endTransfer(tid);
        st.ids.delete(line.id);
      }
      return;
    }
    case "done":
      // Script finished: anything still live skipped its end lines — clean up.
      dropAll(st);
      return;
  }
}

/** Consume newly appended complete lines from PROGRESS_FILE into state. */
export function consumeFile(st: BridgeState, now = Date.now()): void {
  let size = -1;
  try {
    size = statSync(PROGRESS_FILE).size;
  } catch {
    // File missing → writer exited (normal exit unlinks it) or never started.
    if (st.ids.size > 0) dropAll(st);
    st.runId = 0;
    st.offset = 0;
    return;
  }
  if (size < st.offset) {
    // Truncated/recreated by a new run — start over from byte 0.
    dropAll(st);
    st.runId = 0;
    st.offset = 0;
  }
  // Plain `if` (not else-if): after the reset above, size > offset again and
  // the fresh content must be consumed in THIS tick, not one poll later.
  if (size > st.offset) {
    try {
      const buf = readFileSync(PROGRESS_FILE);
      if (buf.length > st.offset) {
        const text = buf.subarray(st.offset).toString("utf8");
        const lastNl = text.lastIndexOf("\n");
        // lastNl < 0 → incomplete line, wait for the writer to finish it.
        if (lastNl >= 0) {
          const complete = text.slice(0, lastNl);
          st.offset += Buffer.byteLength(complete + "\n", "utf8");
          for (const raw of complete.split("\n")) {
            if (!raw.trim()) continue;
            let line: ProgressLine;
            try {
              line = JSON.parse(raw) as ProgressLine;
            } catch {
              continue; // torn/partial write — skip
            }
            applyProgressLine(st, line, now);
          }
        }
      }
    } catch {
      /* vanished between stat and read — next tick retries */
    }
  }
  // Stale check runs on EVERY tick (even with no new bytes): the writer can
  // die mid-upload while we keep polling an unchanged file.
  if (st.ids.size > 0 && now - st.lastActivityAt > STALE_AFTER_MS) {
    // Writer died: drop entries and skip the rest of this file so its lines
    // are never re-consumed (a new run truncates → size < offset).
    dropAll(st);
    st.offset = size;
  }
}

let timer: NodeJS.Timeout | null = null;
const state = newBridgeState();

/** Start polling PROGRESS_FILE (idempotent). Dev mode only — see index.ts. */
export function startDevReleaseProgressTail(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      consumeFile(state);
    } catch (e) {
      console.error("[release-progress] tail error:", e);
    }
  }, POLL_MS);
  timer.unref?.(); // never keep the process alive just for this poller
}

/** Stop polling and drop bridge entries (tests / shutdown). */
export function stopDevReleaseProgressTail(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  dropAll(state);
}
