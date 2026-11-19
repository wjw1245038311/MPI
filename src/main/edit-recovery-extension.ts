import { writeFileSync } from "node:fs";
import { join } from "node:path";
import editRecoverySource from "./mpi-edit-recovery-ext.ts?raw";

/**
 * edit 失败恢复指引 bridge（mpi-edit-recovery-ext.ts）。
 *
 * 与 permission-gate / todo / shellenv 等同一套路：源码以 ?raw 打进主进程，
 * 运行期写进 userData，再以 `pi --extension <path>` 加载。
 *
 * 它做且只做一件事：edit 因「找不到 oldText」失败时，把文件里最接近的一段
 * 附在错误信息后面（带行号与逐行对照）。内置 edit 的匹配行为一点不动——
 * 之所以不接管整个工具，是因为 pi 内置实现已正确处理 CRLF/BOM/多 edits 重叠，
 * 换掉它只会引入新风险（详见该 ext 文件头的说明与上游 issue #8654）。
 */

let cachedPath: string | null = null;

/** 把 edit 恢复扩展写进 userData（一次）并返回其绝对路径。 */
export function ensureEditRecoveryExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-edit-recovery.ts");
  writeFileSync(file, editRecoverySource, "utf8");
  cachedPath = file;
  return file;
}
