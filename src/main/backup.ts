import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { getSessionsDir } from "./session-store";

/**
 * Backup & restore (Settings → 备份与恢复).
 *
 * Two independent artifacts:
 * - Config backup: a single JSON document wrapping the app's config.json.
 *   Import is sanitized field-by-field in config.ts so a stale or foreign file
 *   can never clobber newer settings with defaults.
 * - Session backup: a zip of raw session .jsonl files, laid out exactly like
 *   pi's sessions dir (<encoded-cwd>/<uuid>.jsonl) plus a manifest.json, so an
 *   import restores every session to the same project it came from.
 *
 * Everything here is plain fs + jszip (no Electron), with injectable roots so
 * scripts/test-backup.mjs can exercise round-trips in temp dirs.
 */

export const BACKUP_FORMAT_VERSION = 1;

interface BackupManifest {
  app: "MPI";
  kind: "config" | "sessions";
  version: number;
  exportedAt: string;
  appVersion?: string;
}

function makeManifest(kind: "config" | "sessions", appVersion?: string): BackupManifest {
  return {
    app: "MPI",
    kind,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    ...(appVersion ? { appVersion } : {}),
  };
}

/* ---------------------------- config backup ----------------------------- */

/** Serialize the current app config into a portable JSON document. */
export function buildConfigBackup(config: unknown, appVersion?: string): Buffer {
  const doc = { ...makeManifest("config", appVersion), config };
  return Buffer.from(JSON.stringify(doc, null, 2), "utf8");
}

/**
 * Parse a config backup file. Accepts both the wrapped document produced by
 * buildConfigBackup and a raw config.json (hand-copied). Throws on anything
 * that is not a JSON object / does not contain an object payload.
 */
export function parseConfigBackup(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error("not valid JSON: " + (e?.message || String(e)));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("backup root must be a JSON object");
  }
  const doc = parsed as Record<string, unknown>;
  // Wrapped document ({app:"MPI",kind:"config",config:{...}}) vs raw config.
  const candidate: unknown =
    doc.app === "MPI" && doc.kind === "config" && doc.config !== undefined ? doc.config : doc;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("no settings object found in backup");
  }
  return candidate as Record<string, unknown>;
}

/* --------------------------- session backups ---------------------------- */

/** One subdirectory of pi's sessions dir (a lossy encoding of the project cwd). */
export interface BackupProjectGroup {
  /** Directory name under <sessions>/<dirName>/ — stable key for export/import. */
  dirName: string;
  count: number;
  totalBytes: number;
}

interface DirentLike {
  isDirectory(): boolean;
  name: string;
}

/** Group session files by their subdirectory, with counts and sizes. */
export function listBackupProjects(sessionsRoot?: string): BackupProjectGroup[] {
  const root = sessionsRoot || getSessionsDir();
  if (!existsSync(root)) return [];
  let entries: DirentLike[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: BackupProjectGroup[] = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    let count = 0;
    let totalBytes = 0;
    try {
      for (const f of readdirSync(join(root, d.name))) {
        if (!f.endsWith(".jsonl")) continue;
        count++;
        try {
          totalBytes += statSync(join(root, d.name, f)).size;
        } catch {
          /* unreadable file — still counted */
        }
      }
    } catch {
      continue;
    }
    if (count > 0) out.push({ dirName: d.name, count, totalBytes });
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

/** Normalize a zip entry path to a safe relative path (posix separators), or null.
 * Exported for unit tests — this is the traversal guard on every import. */
export function safeRelPath(entryName: string): string | null {
  const norm = entryName.replace(/\\/g, "/");
  if (!norm || norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return null;
  const parts = norm.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (part === ".." || part === ".") return null;
  }
  return parts.join("/");
}

async function loadZip(): Promise<any> {
  const mod = await import("jszip");
  return (mod as any).default ?? mod;
}

interface ZipSessionFile {
  relPath: string;
  data: Buffer;
}

/** Read a session backup zip and return its .jsonl entries with safe relative paths. */
async function readZipSessions(path: string): Promise<{ manifest: Record<string, unknown> | null; files: ZipSessionFile[] }> {
  const JSZip = await loadZip();
  let zip: any;
  try {
    zip = await new JSZip().loadAsync(readFileSync(path));
  } catch (e: any) {
    throw new Error("not a readable zip file: " + (e?.message || String(e)));
  }
  const manifestEntry = zip.file("manifest.json");
  let manifest: Record<string, unknown> | null = null;
  if (manifestEntry) {
    try {
      const parsed = JSON.parse(await manifestEntry.async("string"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
    } catch {
      /* malformed manifest — ignore, files still importable */
    }
  }
  const files: ZipSessionFile[] = [];
  for (const [name, entry] of Object.entries(zip.files) as Array<[string, any]>) {
    if (entry.dir) continue;
    if (!name.toLowerCase().endsWith(".jsonl")) continue;
    const relPath = safeRelPath(name);
    if (!relPath) continue; // absolute / traversal — refuse silently
    files.push({ relPath, data: await entry.async("nodebuffer") });
  }
  return { manifest, files };
}

/** Export the selected session dirs into a zip at outPath. Returns file count. */
export async function exportSessionsZip(
  outPath: string,
  dirNames: string[],
  appVersion?: string,
  sessionsRoot?: string,
): Promise<number> {
  const root = resolve(sessionsRoot || getSessionsDir());
  const JSZip = await loadZip();
  const zip = new JSZip();
  let count = 0;
  for (const name of dirNames) {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes(sep)) continue;
    const dirPath = join(root, name);
    if (!existsSync(dirPath)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      // Zip entry names always use forward slashes (zip spec); safeRelPath
      // normalizes them back to the platform separator on import.
      zip.file(`${name}/${f}`, readFileSync(join(dirPath, f)));
      count++;
    }
  }
  zip.file("manifest.json", JSON.stringify({ ...makeManifest("sessions", appVersion), count }, null, 2));
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(outPath, buf);
  return count;
}

export interface SessionBackupEntry {
  /** Path relative to the sessions dir, e.g. "E--MyWorkspace-Code-MPI/uuid.jsonl". */
  relPath: string;
  sizeBytes: number;
  status: "new" | "exists";
}

export interface SessionBackupSummary {
  total: number;
  newCount: number;
  existingCount: number;
  entries: SessionBackupEntry[];
}

/** Inspect a session backup zip without writing anything. */
export async function inspectSessionBackup(path: string, sessionsRoot?: string): Promise<SessionBackupSummary> {
  const root = resolve(sessionsRoot || getSessionsDir());
  const { files } = await readZipSessions(path);
  const entries: SessionBackupEntry[] = [];
  for (const f of files) {
    const target = resolve(root, f.relPath);
    if (!target.startsWith(root + sep)) continue; // defense in depth
    entries.push({ relPath: f.relPath, sizeBytes: f.data.length, status: existsSync(target) ? "exists" : "new" });
  }
  const existingCount = entries.filter((e) => e.status === "exists").length;
  return { total: entries.length, newCount: entries.length - existingCount, existingCount, entries };
}

export interface SessionImportResult {
  imported: number;
  skipped: number;
  overwritten: number;
}

/**
 * Restore sessions from a backup zip. policy "skip" leaves already-present
 * files untouched (safe re-import); "overwrite" replaces them with the backup
 * copy. Returns per-outcome counts.
 */
export async function importSessionZip(
  path: string,
  policy: "skip" | "overwrite",
  sessionsRoot?: string,
): Promise<SessionImportResult> {
  const root = resolve(sessionsRoot || getSessionsDir());
  const { files } = await readZipSessions(path);
  mkdirSync(root, { recursive: true });
  let imported = 0;
  let skipped = 0;
  let overwritten = 0;
  for (const f of files) {
    const target = resolve(root, f.relPath);
    if (!target.startsWith(root + sep)) continue; // refuse traversal
    const exists = existsSync(target);
    if (exists && policy === "skip") {
      skipped++;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.data);
    if (exists) overwritten++;
    else imported++;
  }
  return { imported, skipped, overwritten };
}
