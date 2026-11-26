import { getConfig, getConfigDir, reloadConfig, resolveTaskModel, updateConfig, type AutomationTask } from "./config";
import {
  DEFAULT_CATCH_UP_MINUTES,
  decideDueSlot,
  nextRunAfter,
  nextTickDelay,
  slotId,
} from "./automation-schedule";
import { autoAnswerModelSelect, createWebSearchFlow, type WebSearchFlow } from "./web-search-config";
import { createAutomationExtUiHandler } from "./automation-ext-ui";
import { PiBridge } from "./pi-bridge";
import { createGateModeFile, ensureGateExtension, removeGateModeFile } from "./permission-gate";
import { ensureTodoExtension } from "./todo-extension";
import { ensureSmartCompactExtension } from "./compaction-extension";
import { ensureShellEnvExtension } from "./shellenv-extension";
import { prepareShellForSpawn } from "./shell-bootstrap";
import { appendDiagLog } from "./diag-log";
import { deleteRunsForTask, startRun, updateRun } from "./automation-runs-store";
import { createAutomationWorktree, discardAutomationWorktree, type AutomationWorktree } from "./automation-worktree";
import { isRetriableFailure } from "./automation-retry-policy";
import { ingestScheduleInbox } from "./schedule-inbox";
import { runVerifyRules } from "./automation-verify";
import type { AutomationResultNotification } from "./system-notifications";
import { getAgentDir } from "./session-store";
import { buildAppendSystemPrompt } from "./append-prompt";
import { join, resolve } from "node:path";
import { ensureInboxDir, todosFilePath } from "./todo-store";

/**
 * Scheduled automation. Tasks are user-defined prompts (which may invoke
 * skills) run in a chosen working folder on an hourly/daily/weekly schedule.
 *
 * The scheduler lives in the main process and only runs while MPI is
 * open. Each fire spawns a fresh pi session in the task's folder, sends the
 * prompt, and waits for `agent_settled`. pi persists the session automatically,
 * so the result appears in the sidebar as a normal, reviewable thread.
 *
 * Tasks default to sandbox. Since unattended jobs cannot answer approval
 * prompts, a sandbox task fails closed when a gated operation is attempted.
 * Full permission must be selected explicitly per task.
 */

export interface AutomationNotify {
  type: "start" | "done" | "missed" | "draft";
  taskId: string;
  name: string;
  ok?: boolean;
  error?: string;
  /** 本次运行的会话文件（done 事件携带，用于「点击通知 → 打开会话」）。 */
  sessionFile?: string;
}

/** 本次运行的触发来源。 */
export type AutomationTrigger = "schedule" | "catchup" | "manual";

interface AssistantMessageSummary {
  stopReason?: unknown;
  errorMessage?: unknown;
}

export function automationSessionName(taskName: string, language: "en" | "zh"): string {
  return `${language === "zh" ? "定时任务" : "Automation"}: ${taskName}`;
}

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
const running = new Set<string>();
const activeBridges = new Set<PiBridge>();
const activeBridgesByTask = new Map<string, Set<PiBridge>>();
let notify: ((p: AutomationNotify) => void) | null = null;

/** 系统通知钩子：由 ipc 注入（notification center 在那里创建，本模块不 direct 依赖 Electron 窗口）。
 * 定时任务无人值守，窗口在后台时 toast 看不到，失败必须走系统通知。 */
let notifyAutomationResult: ((details: AutomationResultNotification) => void) | null = null;

/** 注册系统通知回调（重复调用以最后一次为准）。 */
export function setAutomationNotifier(fn: (details: AutomationResultNotification) => void): void {
  notifyAutomationResult = fn;
}

/** 兜底重判间隔。
 *
 * 为什么不是 20 秒：链式定时器的价值就是「按下次触发时刻精确排队」，而 20 秒
 * 上限会把所有远于 20 秒的触发都拉回成 20 秒轮询，等于回到了旧实现（只多了
 * 补偿判断）。
 * 为什么不干脆不设上限：时钟被 NTP / 用户改系统时间拨动时，事先排好的长定时器
 * 会偏移；调度非法（算不出下次时刻）时也需要一个定期重判。5 分钟是这两者的折中
 * ——远于 5 分钟的槽位每 5 分钟校一次，近的就精确到秒。 */
const MAX_TICK_DELAY_MS = 5 * 60 * 1000;

// "扩展自动选模" — same web-search.json sync as interactive threads so an
// unattended run's web searches also skip the browser popup and summarize with
// the run's own model. Lazy (config dir must be initialized).
let automationWebSearchFlow: WebSearchFlow | null = null;
function refreshAutomationWebSearchFlow(bridge: PiBridge): void {
  if (getConfig().extAutoPickModel === false) return;
  if (!automationWebSearchFlow) automationWebSearchFlow = createWebSearchFlow(getConfigDir());
  const flow = automationWebSearchFlow;
  void bridge
    .getState()
    .then((s: any) => flow.sync(s?.model ?? null))
    .catch(() => {});
}

function persist(tasks: AutomationTask[]): void {
  updateConfig({ automationTasks: tasks });
}

function persistedTasks(): AutomationTask[] {
  return reloadConfig().automationTasks;
}

function taskStillExists(id: string): boolean {
  return persistedTasks().some((task) => task.id === id);
}

function patchTask(id: string, patch: Partial<AutomationTask>): boolean {
  const tasks = persistedTasks();
  if (!tasks.some((task) => task.id === id)) return false;
  persist(tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  return true;
}

/** 任务补跑窗口（分钟）。缺省/非法值按 DEFAULT_CATCH_UP_MINUTES。 */
function catchUpMinutesOf(task: AutomationTask): number {
  const raw = task.catchUpMinutes;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_CATCH_UP_MINUTES;
  return Math.max(0, Math.min(1440, Math.round(raw)));
}

/**
 * 任务的「上次处理到的槽位」：
 *   1. 新版 lastSlot（精确时刻）；
 *   2. 旧版 lastRunSlot 是日历天粒度，无法还原到分钟，不回退使用；
 *   3. 两者都没有时退回 lastRunAt（历史运行时间戳），否则以 firstSeenAt 为准。
 * 这样升级到批次 A 后，旧任务不会在首次 tick 把当天早些时候的槽位全部补一遍。
 */
function lastSlotOf(task: AutomationTask): Date | null {
  if (typeof task.lastSlot === "string") {
    const t = new Date(task.lastSlot);
    if (!Number.isNaN(t.getTime())) return t;
  }
  if (typeof task.lastRunAt === "number" && Number.isFinite(task.lastRunAt)) return new Date(task.lastRunAt);
  return null;
}

function firstSeenAtOf(task: AutomationTask): Date | null {
  if (typeof task.firstSeenAt === "number" && Number.isFinite(task.firstSeenAt)) return new Date(task.firstSeenAt);
  return null;
}

/** 面板「下次运行」显示用：不落盘，实时算。
 *
 * 基准直接用 `now`：已到点但还没处理的槽位会在几秒内被 tick 领走（那之后
 * 「下次」自然变成下一个槽位）；用旧 lastSlot 做基准会在任务长期未跑时
 * 算出已经过去的时刻，面板上显示成「下次 昨天 09:00」。 */
export function nextRunAtOf(task: AutomationTask, now: Date = new Date()): number | null {
  const next = nextRunAfter(task.schedule, now);
  return next ? next.getTime() : null;
}

/** 正在运行的任务 id（面板据此显示 loading/disabled）。 */
export function runningTaskIds(): string[] {
  return [...running];
}

/**
 * 消费 agent 起草的定时任务（inbox → config，落地为未启用的草稿）。
 *
 * 放在 tick 之前：每 5 分钟兜底重判时顺带扫一次，面板里的「待确认草稿」
 * 就会在下一次刷新时出现。不用 fs.watch —— inbox 只在 agent 主动调用工具时
 * 才有文件写入，5 分钟延迟对「以后每天帮我做某事」这类需求完全够用，
 * 而 watch 会在这个目录上留一个长期句柄。
 */
function ingestScheduleDrafts(): void {
  try {
    const result = ingestScheduleInbox(getConfigDir(), persistedTasks());
    if (!result.added.length) return;
    persist([...persistedTasks(), ...result.added]);
    appendDiagLog(`schedule-drafts added=${result.added.length}`);
    for (const draft of result.added) {
      notify?.({ type: "draft", taskId: draft.id, name: draft.name });
    }
  } catch (e: any) {
    appendDiagLog(`schedule-drafts ingest failed: ${e?.message || e}`);
  }
}

function tick(): void {
  ingestScheduleDrafts();
  const now = new Date();
  // The renderer normally deletes through this process, but another MPI
  // process or an older build may have written config.json. Re-read before
  // every tick so a deleted task cannot continue from a stale memory snapshot.
  const tasks = persistedTasks();

  // 首次被调度器看到的任务：批量写 firstSeenAt（基准时刻），避免把「装好前
  // 已经过去的槽位」全部补一遍。逐任务写会让 config.json 被重写 N 次。
  const unseen = tasks.filter((t) => t.enabled && typeof t.firstSeenAt !== "number");
  if (unseen.length) {
    const ids = new Set(unseen.map((t) => t.id));
    persist(tasks.map((t) => (ids.has(t.id) ? { ...t, firstSeenAt: now.getTime() } : t)));
  }

  for (const task of persistedTasks()) {
    if (!task.enabled) continue;

    const decision = decideDueSlot({
      schedule: task.schedule,
      lastSlot: lastSlotOf(task),
      firstSeenAt: firstSeenAtOf(task),
      now,
      catchUpMinutes: catchUpMinutesOf(task),
    });

    if (decision.kind === "run") {
      // 同任务已在跑（多见于手动「立即运行」未结束时到了计划时刻）：本轮不占位，
      // 等它跑完后的下一次 tick 再判定，宁可晚跑也不并发两个 pi 进程。
      if (running.has(task.id)) continue;
      // 占位必须在 await 之前写：re-entrant tick 不能重复触发同一个槽位。
      patchTask(task.id, {
        lastSlot: slotId(decision.slot),
        lastAttemptAt: now.getTime(),
        lastRunAt: now.getTime(),
      });
      // catchup：计划时刻已过但在补跑窗口内，与「准时」区分开写进历史。
      const lateMin = (now.getTime() - decision.slot.getTime()) / 60_000;
      void execute(task, lateMin >= 1 ? "catchup" : "schedule");
      continue;
    }

    if (decision.kind === "missed") {
      // 超出补跑窗口：不执行，但要留下痕迹，面板能看出「该跑没跑」。
      // 槽位推进到被错过的那个时刻，否则下一次 tick 会反复判定同一个槽位。
      patchTask(task.id, {
        lastSlot: slotId(decision.slot),
        lastMissedAt: decision.slot.getTime(),
        lastStatus: "missed",
        lastError: undefined,
      });
      notify?.({ type: "missed", taskId: task.id, name: task.name });
    }
  }
}

/** 调度器是否已启动。不能拿 `timer` 当这个标志：boot 阶段只挂了 `bootTimer`，
 * `timer` 还是 null，用它做卫兵会让链式调度在第一步就 return——
 * 实测后果是「启动 4 秒后只 tick 一次，之后永不 tick」。 */
let schedulerActive = false;

/** 链式 setTimeout：按「距最近一次触发」排队，睡眠/唤醒后立刻补判。 */
function scheduleNextTick(): void {
  if (!schedulerActive) return;
  if (timer) clearTimeout(timer);
  const now = new Date();
  // pending：该任务此刻「有已到点但未被领走的槽位」。两种情况：
  //   1. 上一轮还在跑（running），本轮 tick 跳过了它；
  //   2. 刚才 tick 没来得及处理（重入 / 异常）。
  // 必须尽快重判，否则要等到下一个计划时刻。
  const entries = persistedTasks()
    .filter((task) => task.enabled)
    .map((task) => ({
      enabled: true,
      schedule: task.schedule,
      pending:
        !running.has(task.id) &&
        decideDueSlot({
          schedule: task.schedule,
          lastSlot: lastSlotOf(task),
          firstSeenAt: firstSeenAtOf(task),
          now,
          catchUpMinutes: catchUpMinutesOf(task),
        }).kind === "run",
      // 同任务正在跑时，pending 不成立（tick 会主动跳过）；但仍要按它的下一个
      // 计划时刻排队，所以 schedule 照传。
    }));
  const delay = nextTickDelay(entries, now, MAX_TICK_DELAY_MS, (schedule, at) => nextRunAfter(schedule, at));
  // 一行诊断：事后能从前一次与后一次的时间戳判断「调度器是不是还活着」。
  appendDiagLog(
    `auto-tick next in ${Math.round(delay / 1000)}s (tasks=${entries.length}, pending=${entries.filter((e) => e.pending).length})`,
  );
  timer = setTimeout(() => {
    timer = null;
    tick();
    scheduleNextTick();
  }, delay);
}

/** 从睡眠/待机恢复后立即补判（不依赖定时器是否被系统暂停）。 */
export function wakeScheduler(): void {
  if (!schedulerActive) return;
  tick();
  scheduleNextTick();
}

/** 任务被新建/修改/删除后重排一次：把「刚改成 1 分钟后」的任务立刻排上。 */
export function rescheduleScheduler(): void {
  scheduleNextTick();
}

/** Remove a task and stop a run that was already spawned for it. */
/** True when an unattended run currently holds a pi process for `cwd` —
 * used to refuse project-path remaps while such a bridge is live. */
export function hasActiveAutomationBridge(cwd: string): boolean {
  const key = resolve(cwd).toLowerCase();
  for (const b of activeBridges) if (resolve(b.cwd).toLowerCase() === key) return true;
  return false;
}

export function removeAutomationTask(id: string): void {
  const tasks = persistedTasks();
  if (tasks.some((task) => task.id === id)) persist(tasks.filter((task) => task.id !== id));
  // 任务删掉后它的运行历史也没意义，一并清掉（否则文件与红点会留着孤儿记录）。
  deleteRunsForTask(id);

  const bridges = activeBridgesByTask.get(id);
  if (!bridges) return;
  for (const bridge of bridges) {
    try {
      bridge.stop();
    } catch {
      /* ignore cancellation races */
    }
  }
}

export function startScheduler(send: (p: AutomationNotify) => void): void {
  notify = send;
  if (schedulerActive) return;
  schedulerActive = true;
  // 先立即判一次（应用刚启动时要补上「启动瞬间已到点」的任务），再按下一次
  // 触发时刻链式排队。旧实现是固定 20s setInterval，漏了睡眠期间的全部触发。
  bootTimer = setTimeout(() => {
    bootTimer = null;
    tick();
    scheduleNextTick();
  }, 4_000);
}

export function stopScheduler(): void {
  schedulerActive = false;
  if (timer) clearTimeout(timer);
  if (bootTimer) clearTimeout(bootTimer);
  timer = null;
  bootTimer = null;
}

/** Stop currently running automation child processes during app shutdown.
 * In-flight runs are aborted and given a bounded moment to settle first so
 * their session files don't end on a dangling tool call (see stopAllBridges). */
export function stopAutomations(): Promise<void> {
  const stops: Promise<void>[] = [];
  for (const bridge of activeBridges) {
    try {
      stops.push(bridge.stopGraceful());
    } catch {
      /* ignore shutdown races */
    }
  }
  return Promise.all(stops).then(() => undefined);
}

/** 默认单次运行超时（分钟）。任务可用 timeoutMinutes 覆盖，上限 180。 */
const DEFAULT_RUN_TIMEOUT_MINUTES = 30;
const MAX_RUN_TIMEOUT_MINUTES = 180;

/** 全局并发上限：同一分钟多个任务时，超出的排队而不是齐开一堆 pi 进程。
 * 每个 pi 子进程约 100–300MB，不设上限在内存紧张的机器上会直接卡死。 */
export function maxConcurrentAutomationRuns(): number {
  const raw = (getConfig() as { maxConcurrentAutomationRuns?: unknown }).maxConcurrentAutomationRuns;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 2;
  return Math.max(1, Math.min(8, Math.round(raw)));
}

/** 任务级超时（分钟）。 */
function timeoutMinutesOf(task: AutomationTask): number {
  const raw = task.timeoutMinutes;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_RUN_TIMEOUT_MINUTES;
  return Math.max(1, Math.min(MAX_RUN_TIMEOUT_MINUTES, Math.round(raw)));
}

/** 失败重试配置：attempts = 总尝试次数（1 = 不重试）。 */
function retryOf(task: AutomationTask): { attempts: number; backoffMinutes: number } {
  const r = task.retry;
  if (!r || typeof r !== "object") return { attempts: 1, backoffMinutes: 0 };
  const attempts = Math.max(1, Math.min(3, Math.round(Number(r.attempts) || 1)));
  const backoffMinutes = Math.max(0, Math.min(60, Math.round(Number(r.backoffMinutes) || 0)));
  return { attempts, backoffMinutes };
}

/**
 * 并发信号量：正在跑的任务数到达上限时，新请求排队等待而不是齐开。
 * 用简单计数 + 等待队列（FIFO），因为：
 *   - 任务数少（单位数），不需要公平调度器；
 *   - 必须先「占位」再启动子进程，否则两个并发 tick 会同时越过上限。
 */
let activeRuns = 0;
const runWaiters: Array<() => void> = [];

function acquireRunSlot(): Promise<void> {
  const limit = maxConcurrentAutomationRuns();
  if (activeRuns < limit) {
    activeRuns++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    runWaiters.push(() => {
      activeRuns++;
      resolve();
    });
  });
}

function releaseRunSlot(): void {
  activeRuns = Math.max(0, activeRuns - 1);
  const next = runWaiters.shift();
  if (next) next();
}

/** 当前正在跑的任务数 / 排队数（面板与诊断用）。 */
export function runSlotStats(): { active: number; waiting: number; limit: number } {
  return { active: activeRuns, waiting: runWaiters.length, limit: maxConcurrentAutomationRuns() };
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Return a failure only when the final assistant message proves that the run
 * did not finish normally. `agent_settled` alone is not enough: pi emits it
 * from a finally block even when a prompt throws or is aborted.
 */
function getAssistantFailure(message: AssistantMessageSummary | null): string | null {
  if (!message) return "Pi 未返回最终助手消息，任务未完成";

  const reason = textValue(message.stopReason);
  const detail = textValue(message.errorMessage);
  if (reason === "error") return detail ? `Pi 返回错误：${detail}` : "Pi 返回错误";
  if (reason === "aborted") {
    return detail && detail !== "Request was aborted" ? `任务被中止：${detail}` : "任务被中止";
  }
  if (reason === "length") return "模型输出达到最大长度限制，结果可能不完整";
  if (reason !== "stop") {
    return reason ? `Pi 在未完成任务时结束（stopReason=${reason}）` : "Pi 未返回有效的完成原因";
  }
  return null;
}

function formatProcessExit(info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): string {
  const code = info.code === null ? "null" : String(info.code);
  const signal = info.signal ? `, signal=${info.signal}` : "";
  const stderr = textValue(info.stderr);
  const detail = stderr ? `：${stderr.slice(-4000)}` : "";
  return `Pi 进程在任务完成前退出（code=${code}${signal}）${detail}`;
}

/**
 * 跑一次任务。`trigger` 写进运行历史，用于区分「按时 / 补跑 / 手动」。
 *
 * 三层保护（批次 C）：
 *   1. 并发信号量：全局同时运行数受 maxConcurrentAutomationRuns 限制，
 *      超出的排队而不是齐开一堆 pi 子进程（每个约 100–300MB）；
 *   2. 任务级超时：默认 30 分钟，可用 timeoutMinutes 覆盖（上限 180）；
 *   3. 失败重试：retry.attempts > 1 时按 backoffMinutes 退避重试，
 *      仅重试「基础设施类」失败（进程退出 / 网络错误），业务失败不重试
 *      ——无人值守下重复跑一个已经确定失败的任务只会浪费额度。
 */
async function execute(task: AutomationTask, trigger: AutomationTrigger = "schedule"): Promise<void> {
  // A tick may have queued execute() just before the task was deleted. Do not
  // create a new Pi process for a task that no longer exists on disk.
  if (!taskStillExists(task.id)) return;
  running.add(task.id);
  patchTask(task.id, { lastStatus: undefined, lastError: undefined });

  const model = resolveTaskModel(task);
  const retry = retryOf(task);
  // 运行历史：排队阶段就写一条（面板能看到「排队中」）。
  // 注意 startedAt 记的是「入队时刻」，排队耗时另记 queuedMs；实际执行时长
  // 要用 finishedAt - startedAtAtRun（拿到名额后才写），否则并发排队的时间会
  // 被算进任务耗时（2026-11-26 实测：B 任务看起来跑了 23s，其中 18s 在排队）。
  const run = startRun({
    taskId: task.id,
    trigger,
    startedAt: Date.now(),
    model: model ? `${model.provider}/${model.modelId}` : undefined,
    status: "queued",
  });

  const stats = runSlotStats();
  if (stats.active >= stats.limit) {
    appendDiagLog(`auto-queue ${task.name} (active=${stats.active} waiting=${stats.waiting} limit=${stats.limit})`);
  }
  // 必须先占位再启动子进程：两个并发 tick 不能同时越过上限。
  await acquireRunSlot();

  // 排队期间任务可能被删。不跑，但要归还名额。
  if (!taskStillExists(task.id)) {
    releaseRunSlot();
    updateRun(run.id, { status: "skipped", finishedAt: Date.now() });
    running.delete(task.id);
    return;
  }

  // 拿到名额：从这一刻起才是真正执行，历史里单独记 startedRunAt。
  const startedRunAt = Date.now();
  const queuedMs = startedRunAt - run.startedAt;
  if (queuedMs >= 1000) appendDiagLog(`auto-start ${task.name} queued=${Math.round(queuedMs / 1000)}s`);
  updateRun(run.id, { startedRunAt, queuedMs });

  notify?.({ type: "start", taskId: task.id, name: task.name });

  /** 会话文件（成功/失败都可能有）。 */
  let sessionFile: string | undefined;
  /** 本次隔离工作树（仅 isolation=worktree 且确为 git 仓库时非空）。
   * 用持有对象而非裸变量：赋值发生在 runOnce 的回调里，TS 的控制流分析
   * 看不到闭包内赋值，裸变量会被收窄成 null → 后续取 .path 报 never。 */
  const worktreeSlot: { current: AutomationWorktree | null } = { current: null };
  const attempts: { at: number; error: string }[] = [];

  try {
    for (let attempt = 1; attempt <= retry.attempts; attempt++) {
      if (attempt > 1) {
        const waitMin = retry.backoffMinutes;
        appendDiagLog(`auto-retry ${task.name} attempt=${attempt}/${retry.attempts} wait=${waitMin}m`);
        updateRun(run.id, { status: "queued", error: undefined, attempts: [...attempts] });
        if (waitMin > 0) await sleep(waitMin * 60_000);
        // 退避期间任务可能被删或被停用。
        if (!taskStillExists(task.id)) break;
      }

      try {
        const attemptResult = await runOnce(task, run.id, model, () => {
          // 隔离工作树按「每次尝试」创建：上一次尝试的半成品不该污染下一次。
          if (task.isolation === "worktree") {
            const prepared = createAutomationWorktree(task.cwd, task.id, run.id);
            if (!prepared.ok) throw new Error(`无法创建工作树：${prepared.reason}`);
            worktreeSlot.current = prepared.worktree;
            appendDiagLog(`auto-worktree ${task.name} -> ${prepared.worktree.path}`);
            return prepared.worktree.path;
          }
          return task.cwd;
        }, startedRunAt);
        sessionFile = attemptResult.sessionFile;
        if (taskStillExists(task.id)) {
          patchTask(task.id, {
            lastStatus: "ok",
            lastError: undefined,
            lastSuccessAt: Date.now(),
            // 一次性任务跑完就自己停用：否则它会留着「下次：—」的僵尸行，
            // 用户还得手动关一遍。
            ...(task.schedule.frequency === "once" ? { enabled: false } : {}),
          });
          updateRun(run.id, {
            status: "ok",
            finishedAt: Date.now(),
            sessionFile,
            worktreePath: worktreeSlot.current?.path,
            ...(attempts.length ? { attempts } : {}),
          });
          notify?.({ type: "done", taskId: task.id, name: task.name, ok: true, sessionFile });
          notifyAutomationResult?.({
            language: getConfig().language === "zh" ? "zh" : "en",
            name: task.name,
            ok: true,
            sessionFile,
          });
        }
        return; // 成功：结束整个 execute
      } catch (e: any) {
        const msg = e?.message || String(e);
        attempts.push({ at: Date.now(), error: msg });
        const isLast = attempt >= retry.attempts;
        const retriable = isRetriableFailure(msg);
        if (!isLast && retriable) {
          // 清掉上一次尝试的工作树（半成品不跨尝试复用）。
          if (worktreeSlot.current) {
            discardAutomationWorktree(worktreeSlot.current);
            worktreeSlot.current = null;
          }
          continue;
        }
        // 不再重试：落最终状态。
        const status = /超时|被中止|aborted/i.test(msg) ? "aborted" : "error";
        if (taskStillExists(task.id)) {
          patchTask(task.id, { lastStatus: "error", lastError: msg });
          // eslint-disable-next-line no-console
          console.error(`[automation] ${task.name}: ${msg}`);
          updateRun(run.id, {
            status,
            finishedAt: Date.now(),
            error: msg,
            sessionFile,
            worktreePath: worktreeSlot.current?.path,
            attempts,
          });
          notify?.({ type: "done", taskId: task.id, name: task.name, ok: false, error: msg, sessionFile });
          notifyAutomationResult?.({
            language: getConfig().language === "zh" ? "zh" : "en",
            name: task.name,
            ok: false,
            error: msg,
            sessionFile,
          });
        }
        return;
      }
    }
  } finally {
    releaseRunSlot();
    running.delete(task.id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** 单次尝试：起 pi 子进程、发 prompt、等到 settle。 */
async function runOnce(
  task: AutomationTask,
  runId: string,
  model: { provider: string; modelId: string } | null,
  resolveCwd: () => string,
  /** 本次运行开始时刻：校验 fileNewerThan 的基准。 */
  runStartedAt: number | undefined,
): Promise<{ sessionFile?: string; cwd: string }> {
  let bridge: PiBridge | null = null;
  let gateModeFile: string | null = null;
  let sessionFile: string | undefined;
  /** 本次尝试的工作目录（校验规则以它为基准）。 */
  let startedCwd = task.cwd;

  await new Promise<void>((resolve, reject) => {
    let done = false;
    let lastAssistantMessage: AssistantMessageSummary | null = null;
    const extUi = createAutomationExtUiHandler({
      respondExtUi: (id, payload) => {
        bridge?.respondExtUi(id, payload);
      },
      autoPickModel: getConfig().extAutoPickModel !== false,
      answerModelSelect: (r) => autoAnswerModelSelect(bridge!, r),
    });
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      fn();
    };
    const timeoutMinutes = timeoutMinutesOf(task);
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`运行超时（${timeoutMinutes} 分钟），任务已停止`)));
      try {
        void bridge?.stopGraceful();
      } catch {
        /* cleanup in finally */
      }
    }, timeoutMinutes * 60_000);

    const permission = task.permission === "full" ? "full" : "sandbox";
    gateModeFile = createGateModeFile(getConfigDir(), permission);
    if (!taskStillExists(task.id)) {
      finish(() => resolve());
      return;
    }
    const runCwd = resolveCwd();
    startedCwd = runCwd;
    // Same shell resolution as interactive threads: unattended runs are
    // exactly where a `No bash shell found` failure is hardest to notice.
    const shell = prepareShellForSpawn(join(getAgentDir(), "settings.json"), runCwd);
    bridge = new PiBridge({
      cwd: runCwd,
      piCliPath: getConfig().piCliPath,
      // Same 知芽 Zhiya injection as interactive sessions. Scheduled runs
      // are never chat-channel sessions, so the mpi_channel_* bridge is not
      // loaded (desktop/automation sessions don't pay for its tools).
      appendSystemPrompt: buildAppendSystemPrompt(),
      shellInfo: shell.info,
      toolFlags: shell.toolFlags,
      extensions: [
        ensureGateExtension(getConfigDir()),
        ensureTodoExtension(getConfigDir()),
        ensureShellEnvExtension(getConfigDir()),
        // Smart-compaction bridge (same as interactive threads): takes over HOW
        // pi summarizes context on compaction; falls back to pi's built-in.
        ensureSmartCompactExtension(getConfigDir()),
      ],
      // Live paths so a customized todo data location is honored.
      todoPaths: { file: todosFilePath(), inboxDir: ensureInboxDir() },
      smartCompactConfigFile: join(getConfigDir(), "config.json"),
      gateModeFile,
      name: automationSessionName(task.name, getConfig().language),
      onEvent: (e: any) => {
        if (e?.type === "agent_start") {
          refreshAutomationWebSearchFlow(bridge!);
          return;
        }
        if (e?.type === "message_end" && e.message?.role === "assistant") {
          lastAssistantMessage = {
            stopReason: e.message.stopReason,
            errorMessage: e.message.errorMessage,
          };
          return;
        }
        if (e?.type !== "agent_settled") return;

        finish(() => {
          const cancelled = extUi.cancelledMethod();
          if (cancelled) {
            reject(new Error(`定时任务需要人工交互（${cancelled}），无人值守运行已停止`));
            return;
          }
          const failure = getAssistantFailure(lastAssistantMessage);
          if (failure) {
            reject(new Error(failure));
            return;
          }
          // 产物校验：模型「正常说完」只是必要条件。以前到这一步就直接 resolve，
          // 于是「脚本退出码 0 但什么都没写」也被记成成功（minibox 2026-11-26 邮件实证）。
          const rules = Array.isArray(task.verify) ? task.verify : [];
          if (rules.length) {
            const outcome = runVerifyRules(rules, { cwd: startedCwd, startedAt: runStartedAt });
            if (!outcome.ok) {
              reject(new Error(`产物校验未通过：${outcome.reason || "未知原因"}`));
              return;
            }
          }
          resolve();
        });
      },
      onExtUi: (r: any) => extUi.handle(r),
      onExit: (info) => finish(() => reject(new Error(formatProcessExit(info)))),
      onError: (err) => finish(() => reject(err)),
    });
    activeBridges.add(bridge);
    let taskBridges = activeBridgesByTask.get(task.id);
    if (!taskBridges) {
      taskBridges = new Set<PiBridge>();
      activeBridgesByTask.set(task.id, taskBridges);
    }
    taskBridges.add(bridge);
    bridgesToCleanup.add(bridge);

    bridge
      .start()
      .then(async () => {
        // 会话文件要等 pi 子进程起来后才有。取不到不影响执行，只是历史里
        // 少一个「打开会话」入口，所以失败静默。
        try {
          const state: any = await bridge!.getState();
          const sf = typeof state?.sessionFile === "string" ? state.sessionFile : "";
          if (sf) {
            sessionFile = sf;
            updateRun(runId, { sessionFile: sf });
          }
        } catch {
          /* 历史里缺会话链接可以接受 */
        }
        if (model) {
          // Explicit task-level model choice. If the model no longer exists,
          // fail with a clear error instead of silently falling back to pi's
          // default — an unattended result produced by the wrong model is
          // worse than no result at all.
          await bridge!.setModel(model.provider, model.modelId);
        }
        return bridge!.prompt(task.prompt);
      })
      .catch((e) => finish(() => reject(e)));
  }).finally(() => {
    const b = bridge as PiBridge | null;
    try {
      void b?.stopGraceful();
    } catch {
      /* ignore */
    }
    if (b) {
      activeBridges.delete(b);
      bridgesToCleanup.delete(b);
      const taskBridges = activeBridgesByTask.get(task.id);
      taskBridges?.delete(b);
      if (taskBridges && taskBridges.size === 0) activeBridgesByTask.delete(task.id);
    }
    if (gateModeFile) removeGateModeFile(gateModeFile);
  });

  return { sessionFile, cwd: startedCwd };
}

/** 需要在 runOnce 收尾时清理的 bridge（跨函数传递用）。 */
const bridgesToCleanup = new Set<PiBridge>();

/** Run a task immediately (the "Run now" button), bypassing the schedule. */
export async function runTaskNow(id: string): Promise<void> {
  const task = persistedTasks().find((t) => t.id === id);
  if (!task) throw new Error("Task not found");
  if (running.has(id)) return;
  patchTask(id, { lastRunAt: Date.now() });
  await execute(task, "manual");
}
