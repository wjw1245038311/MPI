/**
 * 「小 JSON 状态文件」的统一读写（主进程侧）。
 *
 * 为什么要有这个文件：`drafts.json` / `feedback.json` / `todos.json` /
 * `observed-tools.json` 以前各写一份 tmp+rename，`config.json` 更是直接
 * `writeFileSync` 覆写目标。后者在写入中途崩溃 / 断电会留下半截 JSON，下次启动解析
 * 失败 → 该 store 静默回到空状态（配置或待办看起来「凭空丢了」）。
 *
 * 分工：
 *   - 读：{@link readJsonRaw} 只做「读 + 解析，坏文件返回 null」；字段级校验留在各
 *     store（它们的容错策略不同：草稿要逐条 sanitize、待办要丢坏行）。
 *   - 写：{@link writeJsonAtomic} 走 fs-atomic 的临时名 + 原子替换（含 Windows
 *     EPERM 假失败容错）。失败会抛出，由调用方决定吞掉（旁路 sidecar）还是上报。
 *
 * 不改变任何写入时序：合并写（FLUSH_MS）、退出前 flush 仍由各 store 自己掌握。
 */
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic";

/**
 * 读并解析一个 JSON 状态文件。
 *
 * 缺失、无权限、JSON 语法错误一律返回 `null`（调用方按「空初值」继续）。损坏的文件
 * **原地保留**不删不改，便于事后排查；下一次落盘会原子覆盖它。
 */
export function readJsonRaw(file: string): unknown | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * 原子写 JSON。默认紧凑格式（与各文件历史格式一致）；`pretty` 才缩进两格。
 *
 * @throws 落盘失败时抛出（磁盘满、目标被占用且确认没写进去等）。
 */
export function writeJsonAtomic(file: string, value: unknown, opts?: { pretty?: boolean }): void {
  writeFileAtomic(file, JSON.stringify(value, null, opts?.pretty ? 2 : undefined));
}
