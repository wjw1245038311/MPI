/**
 * 把 `mpi-update-ext.ts` 落到 userData 供 pi 以 `--extension` 加载。
 *
 * 与 attach-file / todo 同一套做法：扩展源码在构建时以 `?raw` 内联进主进程，
 * 运行时写一次到 userData（pi 子进程能读到的普通路径）。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import updateSource from "./mpi-update-ext.ts?raw";

let cachedPath: string | null = null;

export function ensureUpdateExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-update.ts");
  writeFileSync(file, updateSource, "utf8");
  cachedPath = file;
  return file;
}
