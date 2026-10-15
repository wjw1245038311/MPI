import { writeFileSync } from "node:fs";
import { join } from "node:path";
import attachFileSource from "./mpi-attach-file-ext.ts?raw";

/**
 * The 附件下行 bridge extension (mpi-attach-file-ext.ts) is bundled into the main
 * process as a raw string and written into userData at runtime, then loaded for
 * every thread via `pi --extension <path>` — same pattern as the todo and
 * choice bridges. It gives the agent the mpi_attach_file tool, which hands a real
 * file to the conversation through the inbox in attach-file-inbox.ts (main stays
 * the only writer of the attachment library).
 */

let cachedPath: string | null = null;

/** Write the attach-file extension into userData (once) and return its absolute path. */
export function ensureAttachFileExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-attach-file.ts");
  writeFileSync(file, attachFileSource, "utf8");
  cachedPath = file;
  return file;
}
