import type { PermissionLevel, TaskModeDef } from "./types";

/**
 * 任务模式 (task modes): named presets bundling per-thread behaviour —
 * permission level + thinking level + optional behavioural instructions.
 * Model stays independent (its own pill). Built-ins: balanced (everyday
 * default) and iterate (loop-dev workflow) plus the pattern-based
 * research/review modes; users can add custom modes via the management modal,
 * each with its own instructions text and/or a markdown spec document
 * (“设计说明书”, skill-like) that the agent follows while the mode is active.
 * Stored in config.json (`taskModes`), normalized here so a hand-edited/corrupt
 * config never breaks the UI.
 */

export type { TaskModeDef };

/** Everyday default: sandbox permission + low thinking. Applied automatically
 * to brand-new conversations and the fallback shown for threads that never had
 * a mode applied. */
export const BUILTIN_BALANCED_ID = "balanced";
/** Long autonomous workflow driven by the loop-dev skill (spec injected). */
export const BUILTIN_ITERATE_ID = "iterate";
export const BUILTIN_RESEARCH_ID = "research";
export const BUILTIN_REVIEW_ID = "review";

/** Portable spec-path prefix: main resolves `@agent/…` against pi's agent dir
 * (<agentDir>/skills/…), so built-in seeds stay valid on every machine/user
 * instead of hardcoding an absolute Windows path. */
export const AGENT_SPEC_PREFIX = "@agent/";
export const BUILTIN_ITERATE_SPEC = `${AGENT_SPEC_PREFIX}skills/loop-dev/SKILL.md`;

/** Built-in ids removed in the 2026-09 task-mode consolidation (default/short/
 * cautious here + the earlier long). Old configs are cleaned outright rather
 * than degraded into deletable custom copies. */
const LEGACY_REMOVED_IDS: ReadonlySet<string> = new Set(["default", "short", "cautious", "long"]);

/** Canonical dropdown order for the built-ins; custom modes follow. */
const BUILTIN_ORDER: readonly string[] = [
  BUILTIN_BALANCED_ID,
  BUILTIN_ITERATE_ID,
  BUILTIN_RESEARCH_ID,
  BUILTIN_REVIEW_ID,
];

const PERMISSION_VALUES: ReadonlySet<string> = new Set(["readonly", "strict", "sandbox", "full"]);
const THINKING_VALUES: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** Safety cap so a corrupt config can't flood the dropdown. */
export const MAX_MODES = 20;
/** Cap for inline instructions (spec documents live in external files). */
const INSTRUCTIONS_MAX_CHARS = 4000;

export const BUILTIN_TASK_MODE_NAMES: Record<string, { zh: string; en: string }> = {
  [BUILTIN_BALANCED_ID]: { zh: "均衡", en: "Balanced" },
  [BUILTIN_ITERATE_ID]: { zh: "迭代", en: "Iterate" },
  [BUILTIN_RESEARCH_ID]: { zh: "调研", en: "Research" },
  [BUILTIN_REVIEW_ID]: { zh: "审查", en: "Review" },
};

/** Default behavioural instructions for the built-in modes (localized; user-
 * editable once saved — same semantics as the other builtin parameters). */
const BUILTIN_TASK_MODE_INSTRUCTIONS: Record<string, { zh: string; en: string }> = {
  [BUILTIN_ITERATE_ID]: {
    zh: "当前处于迭代模式：按 loop-dev 闭环流程执行长任务——先侦察并把大任务拆成小任务（每步 ≤15 分钟），生成计划与文本 DAG（每步含可复现的验收标准）展示给用户并等待批准；批准后逐步执行，每步以检查点验收，发现偏差时只修正受影响的下游步骤并说明；若连续两次修正仍无进展、或发现计划前提有误，立即停下并上报，不要硬撑；任务本身很小时可直接执行，不必走完整流程。全部完成后先集成再验证，向用户汇报与复盘，并把结论沉淀下来（若当前环境配置了记忆/知识库工具则写入其中，否则写入项目内笔记）。完整规范见「模式说明书」（loop-dev skill）。",
    en: "You are in iterate mode: run long tasks through the loop-dev closed-loop workflow — reconnoitre first and split large work into small steps (≤15 min each), produce a plan and a textual DAG (with a reproducible acceptance criterion per step) for the user and WAIT for approval; after approval execute step by step and verify each step against a checkpoint, and when deviation appears fix only the affected downstream steps with an explanation; if two consecutive fixes still make no progress, or a plan assumption turns out wrong, STOP and report instead of pushing on; small tasks may be done directly without the full ceremony. When everything is done, integrate and verify first, then report to the user with a retrospective and persist the conclusions (through whatever memory/knowledge tool is available in this environment, or in a project note otherwise). The full spec is in the mode specification (loop-dev skill).",
  },
  [BUILTIN_RESEARCH_ID]: {
    zh: "当前处于调研模式。目标：不做任何改动，把问题查清并给出可执行方案。流程：① 先明确问题边界、已知约束与未知项；② 广泛收集信息（读项目代码与文档，必要时联网检索）；③ 关键事实尽量多源交叉验证，不要只凭记忆或单一来源。输出（必须）：先给出完整调研报告——a) 结论与关键证据（标注来源：文件:行号 或链接）；b) 明确区分「已核实 / 推测 / 未知」；c) 建议执行步骤（含前置条件、风险与备选）；d) 尚需用户拍板的点。报告后停下等待确认。边界：确认前不要尝试任何写操作；用户确认后，如获相应权限再实施。",
    en: "You are in research mode. Goal: change nothing — investigate the question and produce an actionable plan. Process: (1) first define the problem boundary, known constraints and unknowns; (2) gather information broadly (read project code and docs, search the web when needed); (3) cross-verify key facts across sources rather than relying on memory or a single source. Output (required): present a complete research report — (a) conclusions with key evidence (cite file:line or links); (b) distinguish verified / inferred / unknown; (c) recommended execution steps (with preconditions, risks and alternatives); (d) the points the user still needs to decide. Then STOP and wait for confirmation. Boundary: attempt no write operation before confirmation; implement only after the user confirms and the required permission is granted.",
  },
  [BUILTIN_REVIEW_ID]: {
    zh: "当前处于审查模式。目标：找出问题并给出修复建议，但不实施任何修改。范围：先明确审查对象（用户指定的文件/变更/diff）并声明假设；未覆盖的部分要显式说明。方法：完整通读相关代码后，按严重度列出问题——阻断 > 正确性/逻辑错误 > 安全 > 并发/资源 > 性能 > 可维护性/风格；每个问题必须给出证据（文件:行号 + 触发场景或复现），无证据的猜测应剔除或标注低置信；每个问题附具体修复建议。输出：问题清单 + 本次已检查与未覆盖的说明；输出前自查一遍，剔除误报。",
    en: "You are in review mode. Goal: find problems and propose fixes without applying any change. Scope: first define the review target (the files/changes/diff the user specified) and state your assumptions; explicitly note anything not covered. Method: after reading the relevant code in full, list issues by severity — blocking > correctness/logic errors > security > concurrency/resources > performance > maintainability/style; every issue MUST include evidence (file:line + trigger scenario or reproduction), and unsubstantiated guesses should be dropped or marked low-confidence; attach a concrete fix suggestion to each. Output: the issue list plus what was checked and what was not; self-check once before finalizing to remove false positives.",
  },
};

/** Exact instruction texts shipped in earlier versions but since revised (e.g.
 * the iterate text used to hardcode the "mem0" memory tool — wrong on machines
 * that have no such tool). A stored built-in instruction equal to one of these
 * was never user-edited, so normalizeTaskModes may safely refresh it to the
 * current default; anything else is a user edit and is kept verbatim. */
const RETIRED_BUILTIN_INSTRUCTIONS: readonly string[] = [
  "当前处于迭代模式：按 loop-dev 闭环流程执行长任务——先侦察并把大任务拆成小任务（每步 ≤15 分钟），生成计划与文本 DAG 展示给用户并等待批准；批准后逐步执行，每步以可复现的检查点验收，发现偏差时只修正受影响的下游步骤并说明；全部完成后先集成再验证，把结论写回 mem0 并向用户汇报与复盘。完整规范见「模式说明书」（loop-dev skill）。",
  "You are in iterate mode: run long tasks through the loop-dev closed-loop workflow — reconnoitre first and split large work into small steps (≤15 min each), produce a plan and a textual DAG for the user and WAIT for approval; after approval execute step by step and verify each step against a reproducible checkpoint, and when deviation appears fix only the affected downstream steps with an explanation; when everything is done, integrate and verify first, then write conclusions back to mem0 and report to the user with a retrospective. The full spec is in the mode specification (loop-dev skill).",
  // Previous (env-agnostic) iterate default, superseded by the acceptance-
  // criterion + stop-condition revision.
  "当前处于迭代模式：按 loop-dev 闭环流程执行长任务——先侦察并把大任务拆成小任务（每步 ≤15 分钟），生成计划与文本 DAG 展示给用户并等待批准；批准后逐步执行，每步以可复现的检查点验收，发现偏差时只修正受影响的下游步骤并说明；全部完成后先集成再验证，向用户汇报与复盘，并把结论沉淀下来（若当前环境配置了记忆/知识库工具则写入其中，否则写入项目内笔记）。完整规范见「模式说明书」（loop-dev skill）。",
  "You are in iterate mode: run long tasks through the loop-dev closed-loop workflow — reconnoitre first and split large work into small steps (≤15 min each), produce a plan and a textual DAG for the user and WAIT for approval; after approval execute step by step and verify each step against a reproducible checkpoint, and when deviation appears fix only the affected downstream steps with an explanation; when everything is done, integrate and verify first, then report to the user with a retrospective and persist the conclusions (through whatever memory/knowledge tool is available in this environment, or in a project note otherwise). The full spec is in the mode specification (loop-dev skill).",
  // Superseded research/review defaults (had a redundant read-only prefix now
  // owned by the code-level ENFORCED_READONLY_CONTRACT).
  "当前处于调研模式（本模式强制只读，任何写操作都会被系统拦截）：先广泛收集信息（网络搜索、读文件、查文档），关键事实尽量多源交叉验证；完成后必须先输出完整调研方案——结论（标注来源并区分「已核实」与「推测」）+ 建议执行步骤——然后停下来等待用户确认；在用户明确批准之前，不要尝试任何部署、安装或写操作。信息不足时如实说明，不要编造。",
  "You are in research mode (this mode is enforced read-only — any write operation is blocked by the system): gather information broadly first (web search, reading files, docs) and cross-verify key facts across sources; when done you MUST present a complete research report — conclusions (cite sources, distinguish verified from inferred) plus recommended execution steps — then STOP and wait for the user's confirmation; do NOT attempt any deployment, installation or write operation until the user explicitly approves. If information is insufficient say so honestly instead of guessing.",
  "当前处于审查模式（本模式强制只读，任何写操作都会被系统拦截）：不要修改任何文件或执行写操作；先完整通读相关代码，再按严重度列出问题（阻断 > 逻辑错误 > 性能 > 风格），每个问题给出具体修复建议但不直接实施；输出结论前自查一遍，确认没有误报。",
  "You are in review mode (this mode is enforced read-only — any write operation is blocked by the system): do NOT modify any file or perform write operations; read the relevant code fully first, then list issues by severity (blocking > logic errors > performance > style) with a concrete fix suggestion for each but no direct implementation; before finalizing, self-check once to rule out false positives.",
];

/** Default seeds for the built-in modes (params + instructions are user-editable).
 * `enforce` is a hard floor: research/review stay read-only even if the user
 * re-points their permission at full access. */
export function builtinTaskModes(language: "zh" | "en"): TaskModeDef[] {
  const seed = (
    id: string,
    permission?: PermissionLevel,
    thinking?: string,
    enforce?: "readonly",
    specFile?: string,
  ): TaskModeDef => ({
    id,
    builtin: true,
    ...(permission ? { permission } : {}),
    ...(thinking ? { thinking } : {}),
    ...(enforce ? { enforce } : {}),
    ...(specFile ? { specFile } : {}),
    ...(BUILTIN_TASK_MODE_INSTRUCTIONS[id] ? { instructions: BUILTIN_TASK_MODE_INSTRUCTIONS[id][language] } : {}),
  });
  return [
    // Everyday default first: sandbox + low thinking.
    seed(BUILTIN_BALANCED_ID, "sandbox", "low"),
    // Long autonomous workflow (second most used); spec resolved portably.
    seed(BUILTIN_ITERATE_ID, "full", "low", undefined, BUILTIN_ITERATE_SPEC),
    seed(BUILTIN_RESEARCH_ID, "readonly", "medium", "readonly"),
    seed(BUILTIN_REVIEW_ID, "readonly", "xhigh", "readonly"),
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
  // Enforced read-only overrides any permission choice, so showing both would
  // read as a contradiction (“sandbox · enforced read-only”) — show only the floor.
  if (mode.permission && !mode.enforce) {
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
  // Enforced read-only overrides any permission choice — always visible.
  if (mode.enforce) parts.push(language === "zh" ? "强制只读" : "enforced read-only");
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
  // Only the known value survives; anything else is dropped (corrupt config).
  if (r.enforce === "readonly") mode.enforce = "readonly";
  // Spec docs must be absolute paths (relative ones would resolve against the
  // pi process cwd and silently point at the wrong file) — except the portable
  // `@agent/…` token, which main resolves against pi's agent dir.
  const specFile = typeof r.specFile === "string" ? r.specFile.trim() : "";
  if (specFile.startsWith(AGENT_SPEC_PREFIX)) mode.specFile = specFile;
  else if (/^[a-zA-Z]:[\\/]/.test(specFile)) mode.specFile = specFile; // Windows drive path
  else if (specFile.startsWith("/")) mode.specFile = specFile; // POSIX absolute
  return mode;
}

/** Normalize a raw config value into a safe, complete mode list:
 * built-ins are re-seeded when missing (with localized default instructions),
 * invalid fields dropped, ids deduped, removed built-ins cleaned out. */
export function normalizeTaskModes(raw: unknown, language: "zh" | "en"): TaskModeDef[] {
  const seen = new Map<string, TaskModeDef>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const mode = sanitizeMode(entry);
      if (!mode || seen.has(mode.id)) continue;
      // Removed built-ins must not survive as custom copies.
      if (LEGACY_REMOVED_IDS.has(mode.id)) continue;
      seen.set(mode.id, mode);
    }
  }
  // Re-seed missing built-ins with defaults (user edits to existing ones persist).
  for (const builtin of builtinTaskModes(language)) {
    if (!seen.has(builtin.id)) seen.set(builtin.id, { ...builtin });
  }
  // Refresh retired shipped defaults (see RETIRED_BUILTIN_INSTRUCTIONS): only
  // exact matches to previously shipped text are replaced, so genuine user
  // edits to a built-in instruction are preserved.
  for (const builtin of builtinTaskModes(language)) {
    const m = seen.get(builtin.id);
    if (!m?.builtin || !builtin.instructions || !m.instructions) continue;
    if (RETIRED_BUILTIN_INSTRUCTIONS.includes(m.instructions)) {
      seen.set(builtin.id, { ...m, instructions: builtin.instructions });
    }
  }
  // Research/review are ALWAYS enforced read-only: the flag is part of their
  // safety contract, not a user preference. Configs saved before enforce
  // existed (or hand-edited ones) would otherwise keep the old hole open —
  // users who want research-with-execution can copy it into a custom mode.
  for (const id of [BUILTIN_RESEARCH_ID, BUILTIN_REVIEW_ID]) {
    const m = seen.get(id);
    if (m?.builtin) {
      m.enforce = "readonly";
      // The permission is a dead parameter under the enforced floor; pin it to
      // read-only so the summary/stored config stop advertising “sandbox”.
      m.permission = "readonly";
    }
  }
  const modes = [...seen.values()];
  // Built-ins always lead in canonical order (balanced, iterate, research,
  // review) — even for legacy configs whose saved order differs — with custom
  // modes keeping their relative order after them.
  const builtins = BUILTIN_ORDER.map((id) => modes.find((m) => m.id === id)).filter(
    (m): m is TaskModeDef => !!m,
  );
  const customs = modes.filter((m) => !BUILTIN_ORDER.includes(m.id));
  return [...builtins, ...customs].slice(0, MAX_MODES);
}

/** Resolve the mode brand-new conversations start on: the configured
 * `defaultTaskModeId` when it still exists, else the balanced preset. */
export function resolveDefaultTaskMode(modes: TaskModeDef[], defaultId?: string): TaskModeDef | undefined {
  const id = defaultId && modes.some((m) => m.id === defaultId) ? defaultId : BUILTIN_BALANCED_ID;
  return modes.find((m) => m.id === id) ?? modes.find((m) => m.id === BUILTIN_BALANCED_ID) ?? modes[0];
}
