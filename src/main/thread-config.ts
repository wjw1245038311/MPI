/**
 * 会话配置同步（permission / model / taskMode / thinkingLevel）—— 纯函数核心。
 *
 * 背景：同一个会话的配置能从三个地方改 —— 桌面 UI（IPC）、手机（remote 请求）、
 * agent 自己（模式切换审批）。任一处改完都必须让另外两处**实时**跟上，否则就是
 * 2026-09-15 那个「手机把权限改成沙盒、桌面 pill 还显示完整」的 bug（当时只修了
 * 权限一条路径）。这里把「要广播什么」「模式意味着哪些子变更」抽成纯函数，
 * 便于单测；实际广播（remoteEventHub / IPC）留在 ipc.ts。
 *
 * 不依赖 electron / DOM，可被测试直接 import。
 */
import { builtinTaskModes, normalizeTaskModes, type PermissionLevel, type TaskModeDef } from "../shared/task-mode-catalog";
import type { RemoteModelOption } from "./remote/protocol";

/** 一次配置变更的补丁：只带真正变化的字段。 */
export interface ThreadConfigPatch {
  permission?: PermissionLevel;
  model?: { provider: string; id: string } | null;
  taskMode?: string | null;
  thinkingLevel?: string;
  /**
   * 桥就绪后补推的「可选模型」列表。
   *
   * 为什么需要：`thread.subscribe` 是 **history-first**（刻意不冷启桥），磁盘快照的
   * availableModels 只带 models.json 的配置模型，**不含 pi 目录里的模型**（如 pi.dev
   * 提供的 `deepseek-flash` / “DeepSeek V4.1 Flash”）；而 live 快照是「pi 模型 + 配置
   * 模型」。于是完全重启 App 后，手机 chip 找不到当前模型的显示名、只能显示裸 id，
   * 下拉里也看不到当前模型，得手动刷新（触发 live 快照）才补齐。
   * （2026-09-26 真机：chip 显示 `deepseek-flash`，列表里没有 4.1。）
   */
  availableModels?: RemoteModelOption[];
}

/** 变更来源：远端（手机）需要桌面弹提示；桌面自己操作不需要。 */
export type ConfigChangeOrigin = "desktop" | "remote" | "agent";

/** 丢弃 undefined，空补丁返回 null（调用方据此跳过广播）。 */
export function buildConfigPatch(input: ThreadConfigPatch): ThreadConfigPatch | null {
  const patch: ThreadConfigPatch = {};
  if (input.permission !== undefined) patch.permission = input.permission;
  if (input.model !== undefined) patch.model = input.model;
  if (input.taskMode !== undefined) patch.taskMode = input.taskMode;
  if (input.thinkingLevel !== undefined) patch.thinkingLevel = input.thinkingLevel;
  if (input.availableModels !== undefined) patch.availableModels = input.availableModels;
  return Object.keys(patch).length ? patch : null;
}

/**
 * 解析模式 id → 模式定义。
 *
 * 先按归一化后的用户配置查（用户可能改过内置模式参数、也可能自建模式），
 * 再回退到内置目录 —— 这一步是必要的：config.taskModes 里常常只有用户改动过
 * 的条目（甚至残留已废弃 id），内置的 balanced/iterate 从未落盘，只按 config
 * 查会找不到「迭代模式」。
 */
export function resolveModeById(
  rawModes: unknown,
  modeId: string,
  language: "zh" | "en" = "zh",
): TaskModeDef | null {
  const id = typeof modeId === "string" ? modeId.trim() : "";
  if (!id) return null;
  const modes = normalizeTaskModes(rawModes, language);
  const found = modes.find((m) => m.id === id);
  if (found) return found;
  return builtinTaskModes(language).find((m) => m.id === id) ?? null;
}

/** 应用一个模式会牵动的子变更（模型不在其中——模型有独立选择）。 */
export interface ModeApplication {
  modeId: string;
  permission?: PermissionLevel;
  thinking?: string;
  /** 状态文件内容；null = 删除（清除行为注入）。 */
  state: { instructions: string; specFile: string; enforce: "readonly" | null } | null;
}

/**
 * 模式 → 应用计划。
 *
 * 与渲染进程 applyTaskMode 的顺序语义一致：权限 → 思考等级 → 行为状态文件。
 * 强制只读（research/review）把权限**钉死在 readonly**：它是安全契约而不是用户
 * 偏好，即使模式定义里写着 sandbox 也不放行（归一化已保证，这里再兜一次）。
 */
export function planModeApplication(mode: TaskModeDef): ModeApplication {
  const enforce = mode.enforce === "readonly" ? ("readonly" as const) : null;
  const instructions = typeof mode.instructions === "string" ? mode.instructions.trim() : "";
  const specFile = typeof mode.specFile === "string" ? mode.specFile.trim() : "";
  const permission = enforce === "readonly" ? "readonly" : mode.permission;
  const thinking = typeof mode.thinking === "string" && mode.thinking ? mode.thinking : undefined;
  const hasState = Boolean(instructions || specFile || enforce);
  return {
    modeId: mode.id,
    ...(permission ? { permission } : {}),
    ...(thinking ? { thinking } : {}),
    state: hasState ? { instructions, specFile, enforce } : null,
  };
}

/** 清除模式（切回基线）：只删状态文件与控制位，权限/思考保持用户当前选择。 */
export function planModeClear(): Pick<ModeApplication, "modeId" | "state"> {
  return { modeId: "", state: null };
}

/**
 * 会话级映射的硬上限（兜底用）。正常靠「会话文件还在不在」清理，
 * 这个上限只在极端情况下（比如会话目录被整体换掉）防止 config 无限膨胀。
 */
export const THREAD_KEYED_MAP_LIMIT = 400;

/**
 * 清掉 `threadTaskModes` / `threadThinking` / `threadModels` 里的孤儿键 —— 都按会话 UUID 索引，
 * 但只有「删除会话」这一条路径会回收它们：实测本机已攒到 143 个模式键，而其中绝大多数
 * 对应的会话早已不存在（从没发过消息的草稿、或已删会话的其他设备残留）。
 *
 * 规则（保守优先）：
 *   1. UUID 在现存会话文件集合里 → 保留；
 *   2. 不在 → 删（没会话文件就没地方恢复这些配置，重启后本来也用不上）；
 *   3. 删完仍超上限 → 只留最后写入的 {@link THREAD_KEYED_MAP_LIMIT} 条。
 *
 * UUID 的取法沿用 `threadUuidFromSessionFile()`（调用方负责），别再引一份正则。
 *
 * 纯函数：不读盘、不写配置，便于单测；调用方负责 updateConfig + 日志。
 */
export function pruneThreadKeyedMaps<T>(
  maps: {
    threadTaskModes?: Record<string, T> | null;
    threadThinking?: Record<string, T> | null;
    threadModels?: Record<string, T> | null;
  },
  existingUuids: ReadonlySet<string>,
  limit = THREAD_KEYED_MAP_LIMIT,
): {
  threadTaskModes: Record<string, T>;
  threadThinking: Record<string, T>;
  threadModels: Record<string, T>;
  dropped: string[];
} {
  const dropped = new Set<string>();
  const cleanOne = (raw: Record<string, T> | null | undefined): Record<string, T> => {
    let next: Record<string, T> = {};
    for (const [uuid, value] of Object.entries(raw || {})) {
      if (existingUuids.has(uuid)) next[uuid] = value;
      else dropped.add(uuid);
    }
    const entries = Object.entries(next);
    if (entries.length > limit) {
      for (const [uuid] of entries.slice(0, entries.length - limit)) dropped.add(uuid);
      next = Object.fromEntries(entries.slice(entries.length - limit));
    }
    return next;
  };
  return {
    threadTaskModes: cleanOne(maps.threadTaskModes),
    threadThinking: cleanOne(maps.threadThinking),
    threadModels: cleanOne(maps.threadModels),
    dropped: [...dropped],
  };
}
