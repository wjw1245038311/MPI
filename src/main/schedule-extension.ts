import { writeFileSync } from "node:fs";
import { join } from "node:path";
import scheduleSource from "./mpi-schedule-ext.ts?raw";

/**
 * 定时任务起草扩展（mpi_schedule-ext.ts）以 raw 字符串打进主进程，运行时落盘到
 * configDir，再由 `pi --extension <path>` 加载 —— 与待办 / 权限门禁扩展同一手法。
 *
 * 它只给 agent 一个 mpi_schedule_task 工具：往 inbox 丢草稿，主进程消费后落成
 * **未启用**的任务。真正启用必须由用户在面板里点，避免 agent 自我调度。
 *
 * 只在交互会话加载；定时任务自己的会话不加载（无人值守不该给自己排活）。
 */

let cachedPath: string | null = null;

export function ensureScheduleExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-schedule.ts");
  writeFileSync(file, scheduleSource, "utf8");
  cachedPath = file;
  return cachedPath;
}
