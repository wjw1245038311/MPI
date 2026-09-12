import { writeFileSync } from "node:fs";
import { join } from "node:path";
import choiceSource from "./mpi-choice-ext.ts?raw";

/**
 * The 方案选择 bridge extension (mpi-choice-ext.ts) is bundled into the main
 * process as a raw string and written into userData at runtime, then loaded for
 * interactive threads via `pi --extension <path>` — same pattern as the todo
 * and permission-gate bridges. It gives the agent an mpi_ask_choice tool that
 * surfaces clickable option cards in the chat (existing extension-UI select).
 */

let cachedPath: string | null = null;

/** Write the choice extension into userData (once) and return its absolute path. */
export function ensureChoiceExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-choice.ts");
  writeFileSync(file, choiceSource, "utf8");
  cachedPath = file;
  return file;
}
