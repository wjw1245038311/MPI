/**
 * 渲染进程 / GPU 崩溃的**有界恢复**（2026-11-03，参考 DSH Desktop v0.13.0 的
 * bounded recovery + software-render fallback）。
 *
 * 背景：以前 `render-process-gone` 只往控制台打一行日志——渲染层白屏后用户只能
 * 自己杀进程重启，而且重启后照样白屏（同一个坏驱动）。现在改成：
 *   ① 10 分钟窗口内崩溃 1–2 次 → 自动 reload（大多数是一次性 OOM / GPU 抖动）；
 *   ② 第 3 次仍崩 → 落盘「下次禁用硬件加速」，relaunch 到软件渲染；
 *   ③ 软件渲染下再崩 2 次 → 不再自动重启（避免无限循环），弹窗交给用户；
 *   ④ GPU 子进程在窗口内崩 2 次 → 同样标记软件渲染，下次启动生效（GPU 崩不会
 *      直接拖垮渲染进程，所以不当场 relaunch）。
 *
 * 纯逻辑、不 import electron：`scripts/test-crash-guard.mjs` 直接跑本模块。
 */

export interface CrashEvent {
  /** epoch ms */
  at: number;
  reason: string;
}

export interface CrashGuardState {
  /** 最近窗口内的渲染进程崩溃（按时间升序）。 */
  renderer: CrashEvent[];
  /** 最近窗口内的 GPU 子进程崩溃。 */
  gpu: CrashEvent[];
  /** 下次启动禁用硬件加速（软件渲染兜底）。 */
  softwareRendering?: boolean;
  /** 为什么开的软件渲染（诊断用）。 */
  softwareRenderingReason?: string;
}

/** 判定窗口：10 分钟。超过这个跨度的崩溃不累计（一天崩两次 ≠ 坏驱动）。 */
export const CRASH_WINDOW_MS = 10 * 60 * 1000;
/** 窗口内自动 reload 的次数上限；超过就升级到软件渲染。 */
export const RENDERER_RELOAD_LIMIT = 2;
/** 已经在软件渲染下还崩这么多次 → 不再自动重启。 */
export const SOFTWARE_RENDERING_GIVE_UP_LIMIT = 2;
/** GPU 子进程在窗口内崩这么多次 → 标记软件渲染。 */
export const GPU_CRASH_LIMIT = 2;
/** 落盘时每个列表最多保留多少条（只是防文件膨胀，判定只看窗口内的）。 */
const MAX_KEPT_EVENTS = 20;

export function emptyCrashGuardState(): CrashGuardState {
  return { renderer: [], gpu: [] };
}

/** 允许的时钟前瞻（系统时间被回拨时，未来时间戳不该永远留在窗口里）。 */
const CLOCK_SKEW_MS = 60 * 1000;

/** 丢掉窗口之外的事件（含时钟回拨造成的“未来”事件），并截断到 MAX_KEPT_EVENTS。 */
export function pruneEvents(events: CrashEvent[], now: number, windowMs = CRASH_WINDOW_MS): CrashEvent[] {
  const cutoff = now - windowMs;
  const horizon = now + CLOCK_SKEW_MS;
  return events
    .filter((event) => Number.isFinite(event.at) && event.at > cutoff && event.at <= horizon)
    .slice(-MAX_KEPT_EVENTS);
}

/** 从磁盘/任意输入里还原状态；形状不对的条目直接丢弃，不猜。 */
export function sanitizeCrashGuardState(raw: unknown): CrashGuardState {
  const state = emptyCrashGuardState();
  if (!raw || typeof raw !== "object") return state;
  const value = raw as Record<string, unknown>;
  const list = (input: unknown): CrashEvent[] => {
    if (!Array.isArray(input)) return [];
    const out: CrashEvent[] = [];
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const event = item as Record<string, unknown>;
      if (typeof event.at !== "number" || !Number.isFinite(event.at)) continue;
      out.push({ at: event.at, reason: typeof event.reason === "string" ? event.reason.slice(0, 120) : "" });
    }
    return out.sort((a, b) => a.at - b.at).slice(-MAX_KEPT_EVENTS);
  };
  state.renderer = list(value.renderer);
  state.gpu = list(value.gpu);
  if (value.softwareRendering === true) state.softwareRendering = true;
  if (typeof value.softwareRenderingReason === "string" && value.softwareRenderingReason.trim()) {
    state.softwareRenderingReason = value.softwareRenderingReason.trim().slice(0, 200);
  }
  return state;
}

export type RendererRecovery = "reload" | "software-render" | "give-up";

export interface RendererCrashResult {
  state: CrashGuardState;
  action: RendererRecovery;
  /** 窗口内（含本次）的崩溃次数。 */
  crashesInWindow: number;
}

/**
 * 记一次渲染进程崩溃并给出该做什么。
 *
 * 判定顺序很重要：**先看是不是已经在软件渲染**——否则软件渲染下崩溃会一直被
 * 当作「还没试过软件渲染」而反复 relaunch，正是要避免的无限循环。
 */
export function recordRendererCrash(state: CrashGuardState, at: number, reason: string): RendererCrashResult {
  const next: CrashGuardState = {
    ...state,
    renderer: pruneEvents([...state.renderer, { at, reason: reason.slice(0, 120) }], at),
  };
  const crashesInWindow = next.renderer.length;
  let action: RendererRecovery;
  if (state.softwareRendering) {
    action = crashesInWindow >= SOFTWARE_RENDERING_GIVE_UP_LIMIT ? "give-up" : "reload";
  } else if (crashesInWindow > RENDERER_RELOAD_LIMIT) {
    action = "software-render";
  } else {
    action = "reload";
  }
  return { state: next, action, crashesInWindow };
}

export interface GpuCrashResult {
  state: CrashGuardState;
  /** 本次是否刚刚跨过阈值（调用方据此决定要不要写盘/提示）。 */
  shouldFallbackToSoftware: boolean;
  crashesInWindow: number;
}

export function recordGpuCrash(state: CrashGuardState, at: number, reason: string): GpuCrashResult {
  const next: CrashGuardState = {
    ...state,
    gpu: pruneEvents([...state.gpu, { at, reason: reason.slice(0, 120) }], at),
  };
  const crashesInWindow = next.gpu.length;
  const shouldFallbackToSoftware = !state.softwareRendering && crashesInWindow >= GPU_CRASH_LIMIT;
  return { state: next, shouldFallbackToSoftware, crashesInWindow };
}

/** 打开软件渲染标记（写盘由调用方负责）。 */
export function markSoftwareRendering(state: CrashGuardState, reason: string): CrashGuardState {
  return { ...state, softwareRendering: true, softwareRenderingReason: reason.slice(0, 200) };
}

/** 一行诊断摘要，进 mpi-diag.log。 */
export function crashGuardSummary(state: CrashGuardState, now: number): string {
  const renderer = pruneEvents(state.renderer, now).length;
  const gpu = pruneEvents(state.gpu, now).length;
  return `crash-guard softwareRendering=${state.softwareRendering ? "on" : "off"} renderer=${renderer} gpu=${gpu}`;
}
