import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "./config";

/**
 * Session trash (recycle bin).
 *
 * Deleting a session moves its JSONL out of pi's shared store (~/.pi/agent/sessions)
 * into <userData>/trash/<uuid>.jsonl and records where it came from in index.json,
 * so "delete" is recoverable by default. Only purging from the trash (or deleting
 * with the trash disabled in Settings) removes a session permanently.
 *
 * The trash lives under userData like config.json/drafts.json, so dev ("MPI Dev")
 * and prod ("MPI") profiles keep separate bins.
 */

export interface TrashEntry {
  /** Stable id; also the file name inside the trash directory. */
  id: string;
  /** Absolute path of the session JSONL in pi's store — where restore puts it back. */
  originalFile: string;
  /** Title captured at delete time, for the restore list. */
  title: string;
  /** Project folder that owned the session. */
  cwd: string;
  /** Delete time (ms epoch). */
  deletedAt: number;
  sizeBytes: number;
}

const INDEX_NAME = "index.json";

/** Absolute path of the trash directory (<userData>/trash). */
export function getTrashDir(): string {
  return join(getConfigDir(), "trash");
}

function dir(): string {
  return getTrashDir();
}

function indexFile(): string {
  return join(dir(), INDEX_NAME);
}

let cache: TrashEntry[] | null = null;

function loadIndex(): TrashEntry[] {
  if (cache) return cache;
  const entries: TrashEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(indexFile(), "utf8"));
    if (Array.isArray(parsed)) {
      for (const raw of parsed) {
        if (!raw || typeof raw !== "object") continue;
        const e = raw as Partial<TrashEntry>;
        if (typeof e.id === "string" && typeof e.originalFile === "string") {
          entries.push({
            id: e.id,
            originalFile: e.originalFile,
            title: typeof e.title === "string" ? e.title : "",
            cwd: typeof e.cwd === "string" ? e.cwd : "",
            deletedAt: typeof e.deletedAt === "number" ? e.deletedAt : 0,
            sizeBytes: typeof e.sizeBytes === "number" ? e.sizeBytes : 0,
          });
        }
      }
    }
  } catch {
    // Missing or corrupt index -> treat as empty. Files left behind without an
    // index row are unrecoverable through the UI; that is acceptable for a
    // hand-corrupted bookkeeping file (the sessions themselves were already gone).
  }
  cache = entries;
  return cache;
}

function saveIndex(entries: TrashEntry[]): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(indexFile(), JSON.stringify(entries, null, 2), "utf8");
  cache = entries;
}

/** Move a file, tolerating cross-device moves (userData and ~/.pi can live on
 * different volumes, where rename fails with EXDEV). */
function moveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (error: any) {
    if (error?.code !== "EXDEV") throw error;
    copyFileSync(src, dest);
    unlinkSync(src);
  }
}

/** Retry wrapper for Windows file locks (EPERM/EBUSY/EACCES), mirroring the
 * unlink retry in ipc.ts — a just-stopped bridge can hold the handle briefly. */
async function moveFileWithRetry(src: string, dest: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      moveFile(src, dest);
      return;
    } catch (error: any) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * (attempt + 1)));
    }
  }
  throw lastError || new Error("Could not move file into trash");
}

/** List trash entries, dropping index rows whose file vanished from disk. */
export function listTrash(): TrashEntry[] {
  const entries = loadIndex();
  let changed = false;
  const alive: TrashEntry[] = [];
  for (const entry of entries) {
    if (existsSync(join(dir(), `${entry.id}.jsonl`))) alive.push(entry);
    else changed = true;
  }
  if (changed) saveIndex(alive);
  return alive;
}

/** Move a session file into the trash and record it. Newest entries first. */
export async function moveToTrash(args: { originalFile: string; title?: string; cwd?: string }): Promise<TrashEntry> {
  const source = args.originalFile;
  if (!existsSync(source)) throw new Error("Session file not found");
  mkdirSync(dir(), { recursive: true });
  const entry: TrashEntry = {
    id: randomUUID(),
    originalFile: source,
    title: (args.title || "").trim(),
    cwd: args.cwd || "",
    deletedAt: Date.now(),
    sizeBytes: statSync(source).size,
  };
  await moveFileWithRetry(source, join(dir(), `${entry.id}.jsonl`));
  saveIndex([entry, ...loadIndex()]);
  return entry;
}

/** Move a trashed session back to its original path. */
export function restoreFromTrash(id: string): TrashEntry {
  const entries = loadIndex();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error("Trash entry not found");
  const source = join(dir(), `${id}.jsonl`);
  if (!existsSync(source)) throw new Error("Trashed session file is missing");
  if (existsSync(entry.originalFile)) throw new Error("A session already exists at the original path");
  // pi's per-project subdirectory may have been removed externally; recreate it.
  mkdirSync(dirname(entry.originalFile), { recursive: true });
  moveFile(source, entry.originalFile);
  saveIndex(entries.filter((e) => e.id !== id));
  return entry;
}

/** Permanently delete one trashed session (file + index row). */
export function purgeFromTrash(id: string): void {
  const entries = loadIndex();
  if (!entries.some((e) => e.id === id)) throw new Error("Trash entry not found");
  try {
    unlinkSync(join(dir(), `${id}.jsonl`));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  saveIndex(entries.filter((e) => e.id !== id));
}

/** Permanently delete every trashed session. Returns how many were removed. */
export function emptyTrash(): number {
  const entries = loadIndex();
  for (const entry of entries) {
    try {
      unlinkSync(join(dir(), `${entry.id}.jsonl`));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  saveIndex([]);
  return entries.length;
}
