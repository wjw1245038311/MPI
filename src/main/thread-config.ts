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

/** 一次配置变更的补丁：只带真正变化的字段。 */
export interface ThreadConfigPatch {
  permission?: PermissionLevel;
  model?: { provider: string; id: string } | null;
  taskMode?: string | null;
  thinkingLevel?: string;
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
