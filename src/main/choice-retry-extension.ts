import { writeFileSync } from "node:fs";
import { join } from "node:path";
import choiceRetrySource from "./mpi-choice-retry-ext.ts?raw";

/**
 * choices 格式自动重试 bridge（mpi-choice-retry-ext.ts）以 raw 源码打进主进程，
 * 运行时写进 userData，再由 `pi --extension <path>` 加载 —— 与待办/权限门同一套模式。
 *
 * 它在 agent_settled 后检查最后一条回答的 choices 围栏，失败则注入一条
 * display:false 的修正指令并触发一轮重试（用户不可见）。
 */

let cachedPath: string | null = null;

/** 写入 userData（一次）并返回扩展文件的绝对路径。 */
export function ensureChoiceRetryExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-choice-retry.ts");
  writeFileSync(file, choiceRetrySource, "utf8");
  cachedPath = file;
  return file;
}
