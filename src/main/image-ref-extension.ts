import { writeFileSync } from "node:fs";
import { join } from "node:path";
import imageRefSource from "./mpi-image-ref-ext.ts?raw";

/**
 * 图片引用 bridge（mpi-image-ref-ext.ts）与其它 bridge 同一套装载方式：以 raw 字符串打进主进程、
 * 运行时写入 userData，再通过 `pi --extension <path>` 为每个线程加载。
 *
 * 作用：每次 LLM 调用前问服务端一次「你已缓存哪些图」（`/vision/refs`），把命中的历史图片改成
 * `data:image/x-strata-ref;base64,<hash>` 引用 —— 图不再每轮重发（实测一条作图会话每轮上行 39 MB）。
 * 服务端没有该端点时扩展自动退化为无操作。
 */

let cachedPath: string | null = null;

/** 把图片引用扩展写入 userData（一次），返回其绝对路径。 */
export function ensureImageRefExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-image-ref.ts");
  writeFileSync(file, imageRefSource, "utf8");
  cachedPath = file;
  return file;
}
