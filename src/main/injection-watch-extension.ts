import { writeFileSync } from "node:fs";
import { join } from "node:path";
import injectionWatchSource from "./mpi-injection-watch-ext.ts?raw";

/**
 * 提示注入监测器 bridge（mpi-injection-watch-ext.ts）。
 *
 * 与其它 mpi-*-ext.ts 同一套路：源码以 ?raw 打进主进程，运行期写进 userData，
 * 再以 `pi --extension <path>` 加载。
 *
 * 它挂在 `before_provider_request` 上——这是**最终出口**，拿到的 payload 就是真正发给模型的
 * 内容（transformContext / addendum / 所有扩展的注入都已合入）。命中外来注入标签时把完整请求体
 * 落盘到 `<userData>/injection-watch/`（总份数封顶 40 份），供事后取证。背景见该 ext 文件头。
 *
 * `userDataDir` 会同时作为环境变 MPI_INJECTION_WATCH_DIR 传给 pi 子进程——
 * 早先那个回退到 `process.cwd()` 的写法会把抓包直接写进仓库根（已实测 462 MB / 751 份）。
 */

let cachedPath: string | null = null;

/** 把注入监测扩展写进 userData（一次）并返回其绝对路径。 */
export function ensureInjectionWatchExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-injection-watch.ts");
  writeFileSync(file, injectionWatchSource, "utf8");
  cachedPath = file;
  return file;
}
