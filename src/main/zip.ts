/**
 * Minimal, dependency-free ZIP reader used by the App Store to load app
 * packages. We deliberately avoid pulling a zip library into the main process:
 * app packages can be large (bundled runtimes + models), so extraction streams
 * entry-by-entry instead of loading the whole archive into memory.
 *
 * Supports the two methods produced by every common zip tool: stored (0) and
 * deflate (8), plus the zip64 size/offset overrides (large archives).
 */
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export interface ZipEntry {
  /** Entry name as stored (forward slashes). */
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the local file header. */
  localOffset: number;
}

function u16(b: Buffer, off: number): number {
  return off + 2 <= b.length ? b.readUInt16LE(off) : 0;
}
function u32(b: Buffer, off: number): number {
  return off + 4 <= b.length ? b.readUInt32LE(off) : 0;
}
function u64(b: Buffer, off: number): number {
  return off + 8 <= b.length ? Number(b.readBigUInt64LE(off)) : 0;
}

/** Locate + parse the End Of Central Directory record. Returns null when not a zip. */
function findEocd(fd: number, size: number): { entries: number; cdOffset: number; cdSize: number } | null {
  const maxBack = Math.min(size, 65557 + 8);
  const start = Math.max(0, size - maxBack);
  const buf = Buffer.alloc(size - start);
  readSync(fd, buf, 0, buf.length, start);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (u32(buf, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  let entries = u16(buf, eocd + 10);
  let cdSize = u32(buf, eocd + 12);
  let cdOffset = u32(buf, eocd + 16);

  // zip64: the EOCD64 locator sits immediately before the classic EOCD.
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (u32(buf, i) === EOCD64_LOC_SIG) {
        const eocd64Abs = u64(buf, i + 8);
        const rec = Buffer.alloc(56);
        readSync(fd, rec, 0, 56, eocd64Abs);
        if (u32(rec, 0) === EOCD64_SIG) {
          entries = Number(rec.readBigUInt64LE(32));
          cdSize = Number(rec.readBigUInt64LE(40));
          cdOffset = Number(rec.readBigUInt64LE(48));
        }
        break;
      }
    }
  }
  return { entries, cdOffset, cdSize };
}

/** Parse the central directory into entry records. */
export function listZipEntries(zipPath: string): ZipEntry[] {
  const size = statSync(zipPath).size;
  const fd = openSync(zipPath, "r");
  try {
    const eocd = findEocd(fd, size);
    if (!eocd) throw new Error("Not a valid zip archive");
    const cd = Buffer.alloc(eocd.cdSize);
    if (eocd.cdSize > 0) readSync(fd, cd, 0, cd.length, eocd.cdOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    while (p + 46 <= cd.length && u32(cd, p) === CENTRAL_SIG) {
      const method = u16(cd, p + 10);
      let compressedSize = u32(cd, p + 20);
      let uncompressedSize = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      let localOffset = u32(cd, p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      const extraStart = p + 46 + nameLen;
      // zip64 extended info (0x0001) may override sizes/offset in this order.
      let e = extraStart;
      while (e + 4 <= extraStart + extraLen) {
        const id = u16(cd, e);
        const len = u16(cd, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = u64(cd, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(cd, q); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = u64(cd, q); q += 8; }
        }
        e += 4 + len;
      }
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
      p = extraStart + extraLen + commentLen;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/** Byte offset where an entry's compressed data begins. */
function dataStart(zipPath: string, entry: ZipEntry): number {
  const fd = openSync(zipPath, "r");
  try {
    const hdr = Buffer.alloc(30);
    readSync(fd, hdr, 0, 30, entry.localOffset);
    if (u32(hdr, 0) !== LOCAL_SIG) throw new Error(`corrupt local header for ${entry.name}`);
    return entry.localOffset + 30 + u16(hdr, 26) + u16(hdr, 28);
  } finally {
    closeSync(fd);
  }
}

/** Read one entry (by exact name) into memory; null when absent. */
export function readZipEntry(zipPath: string, name: string): Buffer | null {
  const entry = listZipEntries(zipPath).find((e) => e.name === name && e.compressedSize > 0);
  if (!entry) return null;
  const start = dataStart(zipPath, entry);
  const fd = openSync(zipPath, "r");
  let raw: Buffer;
  try {
    raw = Buffer.alloc(entry.compressedSize);
    if (raw.length > 0) readSync(fd, raw, 0, raw.length, start);
  } finally {
    closeSync(fd);
  }
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`Unsupported compression method ${entry.method} for ${name}`);
}

/** Map an entry name to a safe absolute path under destDir, or null if unsafe. */
export function safeZipDest(destDir: string, name: string): string | null {
  const norm = name.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return null;
  const parts = norm.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  if (parts.length === 0) return null;
  const abs = resolve(destDir, ...parts);
  const base = resolve(destDir);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

/**
 * Extract every entry into destDir, streaming each file (constant memory).
 * Rejects the whole archive when any entry escapes destDir.
 */
export async function extractZip(zipPath: string, destDir: string, stripPrefix = ""): Promise<void> {
  const entries = listZipEntries(zipPath);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    let name = entry.name;
    if (stripPrefix) {
      if (name !== stripPrefix && !name.startsWith(stripPrefix + "/")) continue;
      name = name.slice(stripPrefix.length + 1);
    }
    if (!name) continue;
    const dest = safeZipDest(destDir, name);
    if (!dest) throw new Error(`unsafe path in archive: ${entry.name}`);
    if (name.endsWith("/")) {
      mkdirSync(dest, { recursive: true });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    const start = dataStart(zipPath, entry);
    const source = createReadStream(zipPath, { start, end: start + entry.compressedSize - 1 });
    const sink = createWriteStream(dest);
    if (entry.method === 8) await pipeline(source, createInflateRaw(), sink);
    else if (entry.method === 0) await pipeline(source, sink);
    else throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}`);
  }
}
