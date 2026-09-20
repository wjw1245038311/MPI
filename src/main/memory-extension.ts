import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import memorySource from "./mpi-memory-ext.ts?raw";

/**
 * 记忆池捕获扩展（mpi-memory-ext.ts）以 raw 源码打进主进程，运行时写进 userData，
 * 再由 `pi --extension <path>` 加载 —— 与待办/权限门同一套模式。
 *
 * 它只做「捕获 + 打分」，把候选 JSON 丢进记忆收件箱；**落池由主进程负责**
 * （memory-inbox.ts 是唯一写者），扩展里没有任何池目录写入逻辑。
 */

let cachedPath: string | null = null;

/** 写入 userData（一次）并返回扩展文件的绝对路径。 */
export function ensureMemoryExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-memory.ts");
  writeFileSync(file, memorySource, "utf8");
  cachedPath = file;
  return file;
}

/** 确保记忆候选收件箱目录存在（扩展也会懒创建，这里先建好便于监听）。 */
export function ensureMemoryCandidateInbox(userDataDir: string): string {
  const dir = join(userDataDir, "zhiya-memory-inbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}
