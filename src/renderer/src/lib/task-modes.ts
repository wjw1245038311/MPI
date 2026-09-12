import type { PermissionLevel, TaskModeDef } from "./types";

/**
 * 任务模式 (task modes): named presets bundling per-thread behaviour —
 * permission level + thinking level + optional behavioural instructions.
 * Model stays independent (its own pill). Built-ins: short/long task plus the
 * pattern-based research/review/cautious modes; users can add custom modes via
 * the management modal, each with its own instructions text and/or a markdown
 * spec document (“设计说明书”, skill-like) that the agent follows while the mode
 * is active. Stored in config.json (`taskModes`), normalized here so a
 * hand-edited/corrupt config never breaks the UI.
 */

export type { TaskModeDef };

/** Baseline mode: no parameters, no injection — the explicit “off” position.
 * Also the fallback shown for threads that never had a mode applied. */
export const BUILTIN_DEFAULT_ID = "default";
export const BUILTIN_SHORT_ID = "short";
export const BUILTIN_LONG_ID = "long";
export const BUILTIN_RESEARCH_ID = "research";
export const BUILTIN_REVIEW_ID = "review";
export const BUILTIN_CAUTIOUS_ID = "cautious";

const PERMISSION_VALUES: ReadonlySet<string> = new Set(["readonly", "strict", "sandbox", "full"]);
const THINKING_VALUES: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** Safety cap so a corrupt config can't flood the dropdown. */
export const MAX_MODES = 20;
/** Cap for inline instructions (spec documents live in external files). */
const INSTRUCTIONS_MAX_CHARS = 4000;

export const BUILTIN_TASK_MODE_NAMES: Record<string, { zh: string; en: string }> = {
  [BUILTIN_DEFAULT_ID]: { zh: "默认", en: "Default" },
  [BUILTIN_SHORT_ID]: { zh: "短任务", en: "Short task" },
  [BUILTIN_LONG_ID]: { zh: "长任务", en: "Long task" },
  [BUILTIN_RESEARCH_ID]: { zh: "调研", en: "Research" },
  [BUILTIN_REVIEW_ID]: { zh: "审查", en: "Review" },
  [BUILTIN_CAUTIOUS_ID]: { zh: "谨慎", en: "Cautious" },
};

/** Default behavioural instructions for the built-in modes (localized; user-
 * editable once saved — same semantics as the other builtin parameters). */
const BUILTIN_TASK_MODE_INSTRUCTIONS: Record<string, { zh: string; en: string }> = {
  [BUILTIN_LONG_ID]: {
    zh: "当前处于长任务模式：先把目标拆解为可验证的子任务清单（用待办/todo 跟踪），逐项执行并确认结果；遇到阻塞先记录再继续，不要中途放弃整个计划。",
    en: "You are in long-task mode: first break the goal into a verifiable subtask list (track it with todos), execute item by item and confirm each result; when blocked, record the blocker and continue — do not abandon the whole plan.",
  },
  [BUILTIN_RESEARCH_ID]: {
    zh: "当前处于调研模式：先广泛收集信息（网络搜索、读文件、查文档），关键事实尽量多源交叉验证；除非用户明确要求，不要写或修改代码；输出结论时标注来源并区分「已核实」与「推测」；信息不足时如实说明，不要编造。",
    en: "You are in research mode: gather information broadly first (web search, reading files, docs) and cross-verify key facts across sources; do NOT write or modify code unless explicitly asked; when reporting conclusions cite sources and distinguish verified from inferred; if information is insufficient say so honestly instead of guessing.",
  },
  [BUILTIN_REVIEW_ID]: {
    zh: "当前处于审查模式：不要修改任何文件或执行写操作；先完整通读相关代码，再按严重度列出问题（阻断 > 逻辑错误 > 性能 > 风格），每个问题给出具体修复建议但不直接实施；输出结论前自查一遍，确认没有误报。",
    en: "You are in review mode: do NOT modify any file or perform write operations; read the relevant code fully first, then list issues by severity (blocking > logic errors > performance > style) with a concrete fix suggestion for each but no direct implementation; before finalizing, self-check once to rule out false positives.",
  },
  [BUILTIN_CAUTIOUS_ID]: {
    zh: "当前处于谨慎模式：执行任何破坏性或对外可见的操作（删除文件/数据、git push、发送消息、修改配置）之前，先说明具体影响并等待用户确认；批量操作拆成小步执行；不确定是否可逆时按不可逆处理。",
    en: "You are in cautious mode: before any destructive or externally visible operation (deleting files/data, git push, sending messages, changing configuration), explain the concrete impact and wait for user confirmation; split batch operations into small steps; when unsure whether an action is reversible, treat it as irreversible.",
  },
};

/** Default seeds for the built-in modes (params + instructions are user-editable). */
export function builtinTaskModes(language: "zh" | "en"): TaskModeDef[] {
  const seed = (id: string, permission?: PermissionLevel, thinking?: string): TaskModeDef => ({
    id,
    builtin: true,
    ...(permission ? { permission } : {}),
    ...(thinking ? { thinking } : {}),
    ...(BUILTIN_TASK_MODE_INSTRUCTIONS[id] ? { instructions: BUILTIN_TASK_MODE_INSTRUCTIONS[id][language] } : {}),
  });
  return [
    // Baseline first: the dropdown's top row is “no special behaviour”.
    seed(BUILTIN_DEFAULT_ID),
    seed(BUILTIN_SHORT_ID, "sandbox", "low"),
    seed(BUILTIN_LONG_ID, "sandbox", "high"),
    seed(BUILTIN_RESEARCH_ID, "sandbox", "medium"),
    seed(BUILTIN_REVIEW_ID, "readonly", "xhigh"),
    seed(BUILTIN_CAUTIOUS_ID, "strict", "medium"),
  ];
}

/** Localized display name (built-ins use constants; custom modes their stored name). */
export function taskModeName(mode: TaskModeDef, language: "zh" | "en"): string {
  const builtin = BUILTIN_TASK_MODE_NAMES[mode.id];
  if (builtin) return builtin[language];
  return mode.name?.trim() || (language === "zh" ? "未命名模式" : "Untitled mode");
}

/** One-line parameter summary for dropdown rows, e.g. “沙盒 · 低思考”. */
export function taskModeSummary(mode: TaskModeDef, language: "zh" | "en"): string {
  const parts: string[] = [];
  if (mode.permission) {
    const names: Record<string, { zh: string; en: string }> = {
      readonly: { zh: "只读", en: "Read-only" },
      strict: { zh: "严格", en: "Strict" },
      sandbox: { zh: "沙盒", en: "Sandbox" },
      full: { zh: "完全权限", en: "Full access" },
    };
    parts.push(names[mode.permission][language]);
  }
  if (mode.thinking) {
    const names: Record<string, { zh: string; en: string }> = {
      off: { zh: "思考关闭", en: "Thinking off" },
      minimal: { zh: "最低思考", en: "Minimal thinking" },
      low: { zh: "低思考", en: "Low thinking" },
      medium: { zh: "中思考", en: "Medium thinking" },
      high: { zh: "高思考", en: "High thinking" },
      xhigh: { zh: "极高思考", en: "X-high thinking" },
      max: { zh: "最高思考", en: "Max thinking" },
    };
    const t = names[mode.thinking];
    if (t) parts.push(t[language]);
  }
  // A spec document is worth surfacing in the dropdown; inline instructions alone are not.
  if (mode.specFile?.trim()) parts.push(language === "zh" ? "含说明书" : "with spec");
  return parts.length
    ? parts.join(" · ")
    : language === "zh"
      ? "基线行为（无附加指令）"
      : "Baseline (no extra instructions)";
}

/** Sanitize one raw entry; returns null when it is unusable. */
function sanitizeMode(raw: unknown): TaskModeDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!id) return null;
  const mode: TaskModeDef = { id };
  // Only the known built-in ids may claim builtin (protects delete-block).
  const isBuiltinId = Object.keys(BUILTIN_TASK_MODE_NAMES).includes(id);
  if (isBuiltinId) mode.builtin = true;
  if (typeof r.name === "string" && r.name.trim()) mode.name = r.name.trim().slice(0, 40);
  if (typeof r.permission === "string" && PERMISSION_VALUES.has(r.permission)) {
    mode.permission = r.permission as PermissionLevel;
  }
  if (typeof r.thinking === "string" && THINKING_VALUES.has(r.thinking)) mode.thinking = r.thinking;
  const instructions = typeof r.instructions === "string" ? r.instructions.trim() : "";
  if (instructions) mode.instructions = instructions.slice(0, INSTRUCTIONS_MAX_CHARS);
  // Spec docs must be absolute paths (relative ones would resolve against the
  // pi process cwd and silently point at the wrong file).
  const specFile = typeof r.specFile === "string" ? r.specFile.trim() : "";
  if (specFile && /^[a-zA-Z]:[\\/]/.test(specFile)) mode.specFile = specFile; // Windows drive path
  else if (specFile.startsWith("/")) mode.specFile = specFile; // POSIX absolute
  return mode;
}

/** Normalize a raw config value into a safe, complete mode list:
 * built-ins are re-seeded when missing (with localized default instructions),
 * invalid fields dropped, ids deduped. */
export function normalizeTaskModes(raw: unknown, language: "zh" | "en"): TaskModeDef[] {
  const seen = new Map<string, TaskModeDef>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const mode = sanitizeMode(entry);
      if (!mode || seen.has(mode.id)) continue;
      seen.set(mode.id, mode);
    }
  }
  // Re-seed missing built-ins with defaults (user edits to existing ones persist).
  for (const builtin of builtinTaskModes(language)) {
    if (!seen.has(builtin.id)) seen.set(builtin.id, { ...builtin });
  }
  const modes = [...seen.values()];
  // The baseline “default” mode always leads the dropdown — even for configs
  // saved before it existed (where re-seeding would append it last).
  const di = modes.findIndex((m) => m.id === BUILTIN_DEFAULT_ID);
  if (di > 0) {
    const [def] = modes.splice(di, 1);
    modes.unshift(def);
  }
  return modes.slice(0, MAX_MODES);
}
