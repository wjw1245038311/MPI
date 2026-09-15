import { writeFileSync } from "node:fs";
import { join } from "node:path";
import shellEnvSource from "./mpi-shelenv-ext.ts?raw";

/**
 * The shell-environment bridge (mpi-shelenv-ext.ts) is bundled into the main
 * process as a raw string and written into userData at runtime, then loaded for
 * every thread via `pi --extension <path>` — same pattern as the permission
 * gate, todo, choice and task-mode bridges.
 *
 * It reads MPI_SHELL_INFO (set by pi-bridge from the resolved shell) and appends
 * an `<environment_context>` + shell-policy block to the system prompt, so the
 * model always knows which shell its commands actually run in.
 */

let cachedPath: string | null = null;

/** Write the shell-env extension into userData (once) and return its absolute path. */
export function ensureShellEnvExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-shellev.ts");
  writeFileSync(file, shellEnvSource, "utf8");
  cachedPath = file;
  return file;
}
