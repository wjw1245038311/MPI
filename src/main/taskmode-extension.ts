import { writeFileSync } from "node:fs";
import { join } from "node:path";
import taskModeSource from "./mpi-taskmode-ext.ts?raw";

/**
 * The 任务模式 behaviour bridge (mpi-taskmode-ext.ts) is bundled into the main
 * process as a raw string and written into userData at runtime, then loaded for
 * interactive threads via `pi --extension <path>` — same pattern as the choice
 * and permission-gate bridges. It appends the active mode's instructions/spec
 * document to the system prompt every turn (before_agent_start), so switching
 * modes takes effect live without restarting the pi process.
 */

let cachedPath: string | null = null;

/** Write the task-mode extension into userData (once) and return its absolute path. */
export function ensureTaskModeExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-taskmode.ts");
  writeFileSync(file, taskModeSource, "utf8");
  cachedPath = file;
  return file;
}
