/**
 * Global registry of in-flight transfers (downloads/installs) for the
 * renderer's long-task monitor — the bottom-right floating card that appears
 * once an operation runs longer than 10s.
 *
 * Design notes:
 * - Entries live only while the operation is in flight; begin/update/end are
 *   called from the code paths that own the transfer (extension package
 *   install via npm, Pi core tarball download, app update download).
 * - Speed is a sliding-window estimate over recent byte samples (~6s);
 *   operations without byte accounting (npm) simply omit speed and rely on
 *   `detail` (last output line) plus the renderer-side elapsed clock.
 * - Broadcasts are throttled to EMIT_INTERVAL_MS; the renderer computes
 *   elapsed time locally from startedAt, so no periodic main-process tick is
 *   needed while idle.
 */

import type { TransferInfo } from "../renderer/src/lib/types";

export type { TransferInfo };

interface Entry {
  info: TransferInfo;
  /** (timestamp ms, cumulative bytes) samples for the speed window. */
  samples: Array<{ t: number; b: number }>;
  cancel?: () => void;
  lastEmitAt: number;
}

const EMIT_INTERVAL_MS = 500;
const SPEED_WINDOW_MS = 6_000;

const entries = new Map<string, Entry>();
let seq = 0;
let emit: ((list: TransferInfo[]) => void) | null = null;

/** Wired by ipc.ts once the renderer send channel exists. */
export function setTransferBroadcaster(fn: (list: TransferInfo[]) => void): void {
  emit = fn;
}

function snapshot(): TransferInfo[] {
  return [...entries.values()].map((e) => ({ ...e.info }));
}

function broadcast(force = false): void {
  if (!emit) return;
  const now = Date.now();
  if (!force && now - lastGlobalEmitAt < EMIT_INTERVAL_MS) return;
  lastGlobalEmitAt = now;
  try {
    emit(snapshot());
  } catch (e) {
    console.error("[transfers] broadcast failed:", e);
  }
}

let lastGlobalEmitAt = 0;

function speedFromSamples(samples: Array<{ t: number; b: number }>): number | undefined {
  if (samples.length < 2) return undefined;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  const db = last.b - first.b;
  if (dt <= 0 || db <= 0) return undefined;
  return Math.round((db / dt) * 1000);
}

function pruneSamples(entry: Entry, now: number): void {
  while (entry.samples.length && now - entry.samples[0].t > SPEED_WINDOW_MS) entry.samples.shift();
}

export interface BeginTransferOptions {
  kind?: "download" | "upload";
  label: string;
  totalBytes?: number;
  cancellable?: boolean;
  /** Called when the renderer asks to cancel (kill process / abort fetch). */
  onCancel?: () => void;
}

/** Register an in-flight transfer. Returns its id for update/end calls. */
export function beginTransfer(opts: BeginTransferOptions): string {
  const id = `t${++seq}`;
  entries.set(id, {
    info: {
      id,
      kind: opts.kind || "download",
      label: opts.label,
      startedAt: Date.now(),
      ...(opts.totalBytes ? { totalBytes: opts.totalBytes } : {}),
      cancellable: !!opts.cancellable,
    },
    samples: [],
    cancel: opts.onCancel,
    lastEmitAt: 0,
  });
  broadcast(true);
  return id;
}

export interface UpdateTransferPatch {
  doneBytes?: number;
  totalBytes?: number;
  detail?: string;
  /** Explicit speed (e.g. from electron-updater) overriding the window estimate. */
  speedBps?: number;
}

/** Merge a progress patch into an active transfer and re-broadcast (throttled). */
export function updateTransfer(id: string, patch: UpdateTransferPatch): void {
  const entry = entries.get(id);
  if (!entry) return;
  const now = Date.now();
  if (patch.doneBytes !== undefined) {
    entry.info.doneBytes = patch.doneBytes;
    pruneSamples(entry, now);
    entry.samples.push({ t: now, b: patch.doneBytes });
  }
  if (patch.totalBytes !== undefined) entry.info.totalBytes = patch.totalBytes;
  if (patch.detail !== undefined) entry.info.detail = patch.detail;
  entry.info.speedBps = patch.speedBps ?? speedFromSamples(entry.samples);
  broadcast();
}

/** Remove a finished transfer and re-broadcast immediately. */
export function endTransfer(id: string): void {
  if (entries.delete(id)) broadcast(true);
}

/** Ask an active transfer to cancel. Returns true when a cancellable entry existed. */
export function cancelTransfer(id: string): boolean {
  const entry = entries.get(id);
  if (!entry || !entry.info.cancellable) return false;
  try {
    entry.cancel?.();
  } catch (e) {
    console.error("[transfers] cancel failed:", e);
  }
  // The owning code path ends the transfer once its process/fetch actually dies.
  return true;
}

/** Current snapshot (for late subscribers, e.g. renderer reloads). */
export function getTransfers(): TransferInfo[] {
  return snapshot();
}
