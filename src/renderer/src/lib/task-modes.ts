/**
 * 任务模式（task modes）—— 渲染进程入口。
 *
 * 目录本体（内置模式定义、指令正文、归一化规则）已抽到 `src/shared/task-mode-catalog.ts`，
 * 因为主进程同样需要它：手机端的 remote snapshot（availableModes）与 remote
 * `thread.setMode` 都必须在没有渲染进程的情况下解析同一个模式 id。
 *
 * 这里只做转发，保持既有 `../lib/task-modes` 引用不变。
 */
export {
  AGENT_SPEC_PREFIX,
  BUILTIN_BALANCED_ID,
  BUILTIN_ITERATE_ID,
  BUILTIN_ITERATE_SPEC,
  BUILTIN_RESEARCH_ID,
  BUILTIN_REVIEW_ID,
  BUILTIN_TASK_MODE_NAMES,
  MAX_MODES,
  builtinTaskModes,
  normalizeTaskModes,
  resolveDefaultTaskMode,
  taskModeName,
  taskModeSummary,
} from "../../../shared/task-mode-catalog";
export type { PermissionLevel, TaskModeDef } from "../../../shared/task-mode-catalog";
