import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

/**
 * Minimal diagnostic log for field debugging (e.g. the intermittent
 * "composer greyed out / can't type" report): the renderer sends low-frequency
 * events over IPC and they are appended as JSON lines under
 * userData/logs/mpi-diag.log. Rotates to mpi-diag.old.log once it exceeds
 * MAX_BYTES. Never throws — a logging failure must not affect the app.
 */
const MAX_BYTES = 1_000_000;

export function createDiagLogWriter(file: string): (line: string) => void {
  return (line: string) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      let size = 0;
      try {
        size = statSync(file).size; // first write: file doesn't exist yet
      } catch {
        /* new file */
      }
      if (size > MAX_BYTES) renameSync(file, `${file}.old`);
      appendFileSync(file, line.endsWith("\n") ? line : line + "\n", "utf8");
    } catch {
      /* diagnostics must never break the app */
    }
  };
}

export function diagLogPath(): string {
  return join(app.getPath("userData"), "logs", "mpi-diag.log");
}

let writer: ((line: string) => void) | null = null;

/**
 * Append one line to the diagnostic log (lazy init on first use).
 *
 * 整体再兜一层 try：初始化路径用了 `electron.app`，纯 Node 环境（单元测试
 * 直接 import `remote/service`、`remote/host` 等模块）拿不到 app，
 * `diagLogPath()` 会抛——诊断日志绝不能因此影响主流程。
 */
export function appendDiagLog(line: string): void {
  try {
    if (!writer) writer = createDiagLogWriter(diagLogPath());
    writer(line);
  } catch {
    /* 没有 electron app（测试）或磁盘不可写：静默跳过 */
  }
}
