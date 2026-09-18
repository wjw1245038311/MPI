import { writeFileSync } from "node:fs";
import { join } from "node:path";
import choiceSource from "./mpi-choice-ext.ts?raw";

/**
 * The mode-switch bridge extension (mpi-choice-ext.ts) is bundled into the main
 * process as a raw string and written into userData at runtime, then loaded for
 * interactive threads via `pi --extension <path>` — same pattern as the todo
 * and permission-gate bridges. It gives the agent an mpi_request_mode_switch
 * tool that asks to leave an enforced read-only task mode with one card.
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
