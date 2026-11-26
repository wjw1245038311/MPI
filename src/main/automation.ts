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
  type: "start" | "done" | "missed";
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

function tick(): void {
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

const RUN_TIMEOUT_MS = 30 * 60 * 1000;

/** 全局并发上限：同一分钟多个任务时，超出的排队而不是齐开一堆 pi 进程。
 * 每个 pi 子进程约 100–300MB，不设上限在内存紧张的机器上会直接卡死。 */
export function maxConcurrentAutomationRuns(): number {
  const raw = (getConfig() as { maxConcurrentAutomationRuns?: unknown }).maxConcurrentAutomationRuns;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 2;
  return Math.max(1, Math.min(8, Math.round(raw)));
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

async function execute(task: AutomationTask, trigger: AutomationTrigger = "schedule"): Promise<void> {
  // A tick may have queued execute() just before the task was deleted. Do not
  // create a new Pi process for a task that no longer exists on disk.
  if (!taskStillExists(task.id)) return;
  running.add(task.id);
  patchTask(task.id, { lastStatus: undefined, lastError: undefined });
  notify?.({ type: "start", taskId: task.id, name: task.name });

  // 运行历史：先占一条，成功/失败再回填。会话文件要等 pi 子进程起来后才有，
  // 所以在 start() 之后单独补写（见下面的 sessionFile 赋值）。
  const model = resolveTaskModel(task);
  const run = startRun({
    taskId: task.id,
    trigger,
    startedAt: Date.now(),
    model: model ? `${model.provider}/${model.modelId}` : undefined,
  });

  let bridge: PiBridge | null = null;
  let gateModeFile: string | null = null;
  /** pi 子进程起的会话文件，供运行历史里的「打开会话」用。 */
  let sessionFile: string | undefined;
  try {
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
      const timeout = setTimeout(() => {
        finish(() => reject(new Error("运行超时（30 分钟），任务已停止")));
        try {
          void bridge?.stopGraceful();
        } catch {
          /* cleanup in finally */
        }
      }, RUN_TIMEOUT_MS);

      const permission = task.permission === "full" ? "full" : "sandbox";
      gateModeFile = createGateModeFile(getConfigDir(), permission);
      if (!taskStillExists(task.id)) {
        finish(() => resolve());
        return;
      }
      // Same shell resolution as interactive threads: unattended runs are
      // exactly where a `No bash shell found` failure is hardest to notice.
      const shell = prepareShellForSpawn(join(getAgentDir(), "settings.json"), task.cwd);
      bridge = new PiBridge({
        cwd: task.cwd,
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
            if (failure) reject(new Error(failure));
            else resolve();
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

      const model = resolveTaskModel(task);
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
              updateRun(run.id, { sessionFile: sf });
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
    });
    if (taskStillExists(task.id)) {
      patchTask(task.id, { lastStatus: "ok", lastError: undefined, lastSuccessAt: Date.now() });
      updateRun(run.id, { status: "ok", finishedAt: Date.now() });
      notify?.({ type: "done", taskId: task.id, name: task.name, ok: true, sessionFile });
      notifyAutomationResult?.({ language: getConfig().language === "zh" ? "zh" : "en", name: task.name, ok: true, sessionFile });
    }
  } catch (e: any) {
    const msg = e?.message || String(e);
    // 超时/被停 → aborted，其余算 error；两者都视为「需用户关注」。
    const status = /超时|被中止|aborted/i.test(msg) ? "aborted" : "error";
    if (taskStillExists(task.id)) {
      patchTask(task.id, { lastStatus: "error", lastError: msg });
      // Keep failures visible in the main-process log as well as the settings UI.
      // eslint-disable-next-line no-console
      console.error(`[automation] ${task.name}: ${msg}`);
      updateRun(run.id, { status, finishedAt: Date.now(), error: msg });
      notify?.({ type: "done", taskId: task.id, name: task.name, ok: false, error: msg, sessionFile });
      notifyAutomationResult?.({ language: getConfig().language === "zh" ? "zh" : "en", name: task.name, ok: false, error: msg, sessionFile });
    }
  } finally {
    const b = bridge as PiBridge | null;
    try {
      void b?.stopGraceful();
    } catch {
      /* ignore */
    }
    if (b) {
      activeBridges.delete(b);
      const taskBridges = activeBridgesByTask.get(task.id);
      taskBridges?.delete(b);
      if (taskBridges && taskBridges.size === 0) activeBridgesByTask.delete(task.id);
    }
    if (gateModeFile) removeGateModeFile(gateModeFile);
    running.delete(task.id);
  }
}

/** Run a task immediately (the "Run now" button), bypassing the schedule. */
export async function runTaskNow(id: string): Promise<void> {
  const task = persistedTasks().find((t) => t.id === id);
  if (!task) throw new Error("Task not found");
  if (running.has(id)) return;
  patchTask(id, { lastRunAt: Date.now() });
  await execute(task, "manual");
}
