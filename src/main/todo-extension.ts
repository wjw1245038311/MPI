import { writeFileSync } from "node:fs";
import { join } from "node:path";
import todoSource from "./mpi-todo-ext.ts?raw";

/**
 * The 待办任务 bridge extension (mpi-todo-ext.ts) is bundled into the main
 * process as a raw string and written into userData at runtime, then loaded for
 * every thread via `pi --extension <path>` — same pattern as the permission
 * gate. It gives the agent mpi_todo_add / mpi_todo_list tools that persist to
 * the app's todo store through the inbox directory (see todo-store.ts).
 */

let cachedPath: string | null = null;

/** Write the todo extension into userData (once) and return its absolute path. */
export function ensureTodoExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-todo.ts");
  writeFileSync(file, todoSource, "utf8");
  cachedPath = file;
  return file;
}

