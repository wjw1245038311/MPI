import type { PermissionLevel, TaskModeDef } from "./types";

/**
 * 任务模式 (task modes): named presets bundling per-thread behaviour knobs —
 * permission level + thinking level. Model stays independent (its own pill).
 * Built-in defaults: short task / long task; users can add custom modes via the
 * management modal. Stored in config.json (`taskModes`), normalized here so a
 * hand-edited/corrupt config never breaks the UI.
 */

export type { TaskModeDef };

export const BUILTIN_SHORT_ID = "short";
export const BUILTIN_LONG_ID = "long";

const PERMISSION_VALUES: ReadonlySet<string> = new Set(["readonly", "strict", "sandbox", "full"]);
const THINKING_VALUES: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** Safety cap so a corrupt config can't flood the dropdown. */
export const MAX_MODES = 20;

export const BUILTIN_TASK_MODE_NAMES: Record<string, { zh: string; en: string }> = {
  [BUILTIN_SHORT_ID]: { zh: "短任务", en: "Short task" },
  [BUILTIN_LONG_ID]: { zh: "长任务", en: "Long task" },
};

/** Default seeds for the two built-in modes (params are user-editable). */
export function builtinTaskModes(): TaskModeDef[] {
  return [
    { id: BUILTIN_SHORT_ID, builtin: true, permission: "sandbox", thinking: "low" },
    { id: BUILTIN_LONG_ID, builtin: true, permission: "sandbox", thinking: "high" },
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
  return parts.length ? parts.join(" · ") : language === "zh" ? "未设置参数" : "No parameters";
}

/** Sanitize one raw entry; returns null when it is unusable. */
function sanitizeMode(raw: unknown): TaskModeDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!id) return null;
  const mode: TaskModeDef = { id };
  // Only the two known built-in ids may claim builtin (protects delete-block).
  if (id === BUILTIN_SHORT_ID || id === BUILTIN_LONG_ID) mode.builtin = true;
  if (typeof r.name === "string" && r.name.trim()) mode.name = r.name.trim().slice(0, 40);
  if (typeof r.permission === "string" && PERMISSION_VALUES.has(r.permission)) {
    mode.permission = r.permission as PermissionLevel;
  }
  if (typeof r.thinking === "string" && THINKING_VALUES.has(r.thinking)) mode.thinking = r.thinking;
  return mode;
}

/** Normalize a raw config value into a safe, complete mode list:
 * built-ins are re-seeded when missing, invalid fields dropped, ids deduped. */
export function normalizeTaskModes(raw: unknown): TaskModeDef[] {
  const seen = new Map<string, TaskModeDef>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const mode = sanitizeMode(entry);
      if (!mode || seen.has(mode.id)) continue;
      seen.set(mode.id, mode);
    }
  }
  // Re-seed missing built-ins with defaults (user edits to existing ones persist).
  for (const builtin of builtinTaskModes()) {
    if (!seen.has(builtin.id)) seen.set(builtin.id, { ...builtin });
  }
  return [...seen.values()].slice(0, MAX_MODES);
}
