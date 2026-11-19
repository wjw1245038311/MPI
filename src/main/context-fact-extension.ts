import { writeFileSync } from "node:fs";
import { join } from "node:path";
import contextFactSource from "./mpi-context-fact-ext.ts?raw";

/**
 * 压缩后上下文事实 bridge（mpi-context-fact-ext.ts）。
 *
 * 与其它 mpi-*-ext.ts 同一套路：源码以 ?raw 打进主进程，运行期写进 userData，
 * 再以 `pi --extension <path>` 加载。
 *
 * 它只做一件事：压缩完成（session_compact）后注入一条 display:false 的系统事实，
 * 把**真实的**窗口与压缩前占用告诉模型。起因见该 ext 文件头：
 * pi 压缩后 contextUsage 返回 null，模型在信息真空里自己编出了「180k 预算」「不足 5%」。
 */

let cachedPath: string | null = null;

/** 把上下文事实扩展写进 userData（一次）并返回其绝对路径。 */
export function ensureContextFactExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-context-fact.ts");
  writeFileSync(file, contextFactSource, "utf8");
  cachedPath = file;
  return file;
}
