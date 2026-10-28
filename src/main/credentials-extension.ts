import { writeFileSync } from "node:fs";
import { join } from "node:path";
import credentialsSource from "./mpi-credentials-ext.ts?raw";

/**
 * 凭据注入 bridge（mpi-credentials-ext.ts）的落盘器 —— 与 shellenv / todo / gate
 * 同一套做法：扩展源码被主进程当 raw 字符串打包，运行时写进 userData，再用
 * `pi --extension <path>` 加载。
 *
 * 该扩展只读 `MPI_SECRET_META`（变量名 + 引用名 + 用途，不含值），把「有哪些凭据可用、
 * 如何引用、禁止打印」写进系统提示。值本身由 pi-bridge 注入进程环境，见
 * docs/CREDENTIALS-VAULT.md §4.2。
 */

let cachedPath: string | null = null;

export function ensureCredentialsExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-credentials.ts");
  writeFileSync(file, credentialsSource, "utf8");
  cachedPath = file;
  return file;
}
