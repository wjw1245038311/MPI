import { writeFileSync } from "node:fs";
import { join } from "node:path";
import smartCompactSource from "./mpi-smart-compact-ext.ts?raw";

/**
 * The smart-compaction bridge extension (mpi-smart-compact-ext.ts) is bundled into the
 * main process as a raw string and written into userData at runtime, then loaded for
 * every thread via `pi --extension <path>` — same pattern as the todo/choice bridges.
 * It takes over HOW pi compacts context (session_before_compact): CJK-aware estimation,
 * hierarchical chunked summarization with a small model, verbatim user-message carry-over.
 * Any failure inside it falls back to pi's built-in summarizer — never blocks compaction.
 */

let cachedPath: string | null = null;

/** Write the smart-compact extension into userData (once) and return its absolute path. */
export function ensureSmartCompactExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-smart-compact.ts");
  writeFileSync(file, smartCompactSource, "utf8");
  cachedPath = file;
  return file;
}
