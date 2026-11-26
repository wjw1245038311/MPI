import { join } from "node:path";
import { getConfigDir } from "./config";
import { readJsonRaw, writeJsonAtomic } from "./json-store";

/**
 * 定时任务的运行历史（sidecar，不进 config.json）。
 *
 * 为什么不并进 config.json：config.json 是「设置导入/导出」的整体单元
 * （config.ts 的导入白名单），把运行历史塞进去会让「导入别人的设置」携带
 * 无意义的历史，也会让每次运行都重写整份配置（里面还有模型、远程信令等）。
 *
 * 存储结构按任务分组，便于面板「展开某任务的历史」直接切片；同时受两层上限
 * 约束（每任务 30 条 / 全局 500 条），淘汰按 startedAt 从旧到新。
 */

export type AutomationRunStatus = "ok" | "error" | "missed" | "aborted" | "skipped";
export type AutomationRunTrigger = "schedule" | "catchup" | "manual";

export interface AutomationRun {
  id: string;
  taskId: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  startedAt: number;
  finishedAt?: number;
  /** 失败原因（status=error/aborted 时有值）。 */
  error?: string;
  /** 会话文件绝对路径：面板「打开会话」用。 */
  sessionFile?: string;
  /** 实际使用的模型（provider/modelId），便于对照「这次是不是换了模型」。 */
  model?: string;
  /** 失败重试记录（批次 C 用，先留字段）。 */
  attempts?: { at: number; error: string }[];
  /** 用户是否已查看过这次结果。失败未查看 = 需在侧栏提示。 */
  reviewed?: boolean;
}

interface RunsFile {
  version: 1;
  runs: Record<string, AutomationRun[]>;
}

/** 每任务保留条数。 */
export const MAX_RUNS_PER_TASK = 30;
/** 全局保留条数（任务很多时防止文件无限增长）。 */
export const MAX_RUNS_TOTAL = 500;
/** 合并写入窗口，避免一次运行写多次盘。 */
const FLUSH_MS = 400;

let cache: RunsFile | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let idSeq = 0;

function file(): string {
  return join(getConfigDir(), "automation-runs.json");
}

function newId(): string {
  idSeq = (idSeq + 1) % 1000;
  return `run-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

function sanitizeRun(raw: unknown): AutomationRun | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.taskId !== "string" || !r.taskId) return null;
  const status: AutomationRunStatus =
    r.status === "ok" || r.status === "error" || r.status === "missed" || r.status === "aborted" || r.status === "skipped"
      ? r.status
      : "error";
  const trigger: AutomationRunTrigger =
    r.trigger === "schedule" || r.trigger === "catchup" || r.trigger === "manual" ? r.trigger : "schedule";
  const startedAt = typeof r.startedAt === "number" && Number.isFinite(r.startedAt) ? r.startedAt : Date.now();
  const out: AutomationRun = { id: r.id, taskId: r.taskId, trigger, status, startedAt };
  if (typeof r.finishedAt === "number" && Number.isFinite(r.finishedAt)) out.finishedAt = r.finishedAt;
  if (typeof r.error === "string" && r.error) out.error = r.error.slice(0, 4000);
  if (typeof r.sessionFile === "string" && r.sessionFile) out.sessionFile = r.sessionFile;
  if (typeof r.model === "string" && r.model) out.model = r.model;
  if (typeof r.reviewed === "boolean") out.reviewed = r.reviewed;
  if (Array.isArray(r.attempts)) {
    const attempts = r.attempts
      .filter((a): a is { at: number; error: string } => !!a && typeof a === "object")
      .map((a) => {
        const item = a as Record<string, unknown>;
        return {
          at: typeof item.at === "number" ? item.at : 0,
          error: typeof item.error === "string" ? item.error.slice(0, 1000) : "",
        };
      });
    if (attempts.length) out.attempts = attempts;
  }
  return out;
}

function ensureLoaded(): RunsFile {
  if (cache) return cache;
  const empty: RunsFile = { version: 1, runs: {} };
  try {
    const parsed = readJsonRaw(file());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (obj.runs && typeof obj.runs === "object" && !Array.isArray(obj.runs)) {
        for (const [taskId, list] of Object.entries(obj.runs as Record<string, unknown>)) {
          if (!Array.isArray(list)) continue;
          const runs = list.map(sanitizeRun).filter((r): r is AutomationRun => !!r);
          if (runs.length) empty.runs[taskId] = runs;
        }
      }
    }
  } catch {
    // 文件缺失或损坏：从空历史开始。不在这里覆盖损坏文件——下一次 flush 会原子
    // 替换它，但读失败时保留现场更利于排查（writeJsonAtomic 会整体重写）。
  }
  cache = empty;
  return empty;
}

function prune(data: RunsFile): void {
  for (const [taskId, list] of Object.entries(data.runs)) {
    if (list.length > MAX_RUNS_PER_TASK) {
      data.runs[taskId] = list.slice(list.length - MAX_RUNS_PER_TASK);
    }
    if (data.runs[taskId].length === 0) delete data.runs[taskId];
  }
  const total = Object.values(data.runs).reduce((n, list) => n + list.length, 0);
  if (total <= MAX_RUNS_TOTAL) return;
  // 超全局上限：按 startedAt 从旧到新逐个删除最早的一条，直到回到上限以内。
  let overflow = total - MAX_RUNS_TOTAL;
  while (overflow > 0) {
    let oldestTask: string | null = null;
    let oldestAt = Infinity;
    for (const [taskId, list] of Object.entries(data.runs)) {
      const first = list[0];
      if (first && first.startedAt < oldestAt) {
        oldestAt = first.startedAt;
        oldestTask = taskId;
      }
    }
    if (!oldestTask) break;
    data.runs[oldestTask].shift();
    if (data.runs[oldestTask].length === 0) delete data.runs[oldestTask];
    overflow--;
  }
}

function writeThrough(): void {
  try {
    writeJsonAtomic(file(), ensureLoaded());
  } catch {
    // 运行历史是辅助数据，磁盘不可写时绝不因此中断任务执行。
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeThrough();
  }, FLUSH_MS);
  // 不阻止进程退出：历史丢掉几条可以接受，卡住 shutdown 不行。
  flushTimer.unref?.();
}

/** 同步落盘（测试与退出前用）。 */
export function flushAutomationRuns(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  writeThrough();
}

/** 新建一条运行记录（status 初值为 running 之外的第一个确定值由调用方给）。 */
export function startRun(input: {
  taskId: string;
  trigger: AutomationRunTrigger;
  status?: AutomationRunStatus;
  startedAt?: number;
  model?: string;
}): AutomationRun {
  const data = ensureLoaded();
  const run: AutomationRun = {
    id: newId(),
    taskId: input.taskId,
    trigger: input.trigger,
    status: input.status ?? "skipped",
    startedAt: typeof input.startedAt === "number" ? input.startedAt : Date.now(),
  };
  if (input.model) run.model = input.model;
  const list = data.runs[input.taskId] ?? [];
  list.push(run);
  data.runs[input.taskId] = list;
  prune(data);
  scheduleFlush();
  return run;
}

/** 更新一条已存在的运行记录；找不到时返回 false（例如历史被清空）。 */
export function updateRun(runId: string, patch: Partial<Omit<AutomationRun, "id" | "taskId">>): boolean {
  const data = ensureLoaded();
  for (const list of Object.values(data.runs)) {
    const idx = list.findIndex((r) => r.id === runId);
    if (idx < 0) continue;
    list[idx] = { ...list[idx], ...patch };
    prune(data);
    scheduleFlush();
    return true;
  }
  return false;
}

/** 某任务的运行历史，最新在前。 */
export function listRuns(taskId: string, limit = MAX_RUNS_PER_TASK): AutomationRun[] {
  const list = ensureLoaded().runs[taskId] ?? [];
  return list.slice(-limit).reverse().map((r) => ({ ...r }));
}

/** 全部任务的最新一条历史（面板首屏摘要用）。 */
export function latestRunsByTask(): Record<string, AutomationRun> {
  const out: Record<string, AutomationRun> = {};
  for (const [taskId, list] of Object.entries(ensureLoaded().runs)) {
    const last = list[list.length - 1];
    if (last) out[taskId] = { ...last };
  }
  return out;
}

/** 失败且未查看的记录数（侧栏红点用）。 */
export function unreviewedFailureCount(): number {
  let n = 0;
  for (const list of Object.values(ensureLoaded().runs)) {
    for (const r of list) {
      if (!r.reviewed && (r.status === "error" || r.status === "aborted")) n++;
    }
  }
  return n;
}

/** 标记已查看。不传 ids = 把所有未查看的失败标记为已查看。 */
export function markRunsReviewed(ids?: string[]): number {
  const data = ensureLoaded();
  const wanted = ids ? new Set(ids) : null;
  let changed = 0;
  for (const list of Object.values(data.runs)) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r.reviewed) continue;
      if (r.status !== "error" && r.status !== "aborted") continue;
      if (wanted && !wanted.has(r.id)) continue;
      list[i] = { ...r, reviewed: true };
      changed++;
    }
  }
  if (changed) scheduleFlush();
  return changed;
}

/** 删除某个任务的全部历史（任务被删除时调用）。 */
export function deleteRunsForTask(taskId: string): void {
  const data = ensureLoaded();
  if (!data.runs[taskId]) return;
  delete data.runs[taskId];
  scheduleFlush();
}

/** 测试用：清空内存缓存，强制下次从磁盘重读。 */
export function resetAutomationRunsCache(): void {
  cache = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
