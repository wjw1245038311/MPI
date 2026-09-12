/**
 * Renderer-side helpers for the 方案选择 (mpi_ask_choice) feature.
 *
 * The extension (src/main/mpi-choice-ext.ts, mirrored by src/main/choice-logic.ts)
 * writes a stable title prefix before ctx.ui.select() and returns canonical
 * result texts; this module recognizes both so the live card (ExtUiPromptCard)
 * and the history card (Chat ChoiceToolCard) can render them cleanly. Keep in
 * sync with choice-logic.ts / mpi-choice-ext.ts.
 */

/** Stable title prefix written by the extension (see choice-logic.ts). */
export const CHOICE_TITLE_PREFIX_RE = /^(?:方案选择|Plan\s+choice)\s*[:：]/i;

/** True when an extui select request is a plan-choice dialog, not a permission gate. */
export function isChoiceTitle(title: unknown): boolean {
  if (typeof title !== "string") return false;
  const firstLine = title.split(/\r?\n/, 1)[0].trim();
  return CHOICE_TITLE_PREFIX_RE.test(firstLine);
}

/** Remove the marker prefix so cards show only the agent's question. */
export function stripChoicePrefix(title: string): string {
  const line = String(title || "").split(/\r?\n/, 1)[0] || "";
  return line.replace(CHOICE_TITLE_PREFIX_RE, "").trim() || line.trim();
}

/** Canonical result texts produced by the extension (keep in sync). */
const SELECTED_ZH_RE = /^用户已选择：「(.+)」/;
const SELECTED_EN_RE = /^User selected:\s*"(.*)"/;
const CANCELLED_RE = /未做出选择|did not select/i;

export type ChoiceOutcome =
  | { kind: "selected"; value: string }
  | { kind: "cancelled" }
  | null;

/** Parse the mpi_ask_choice tool result back into a structured outcome. */
export function parseChoiceOutcome(resultText: unknown): ChoiceOutcome {
  if (typeof resultText !== "string") return null;
  const text = resultText.trim();
  const zh = SELECTED_ZH_RE.exec(text);
  if (zh) return { kind: "selected", value: zh[1] };
  const en = SELECTED_EN_RE.exec(text);
  if (en) return { kind: "selected", value: en[1] };
  if (CANCELLED_RE.test(text)) return { kind: "cancelled" };
  return null;
}

/** One option as displayed on the cards. `detail` is an optional longer
 * explanation shown in an expandable section (mpi_ask_choice options may be
 * plain strings or {label, detail} objects — see mpi-choice-ext.ts). */
export interface ChoiceOptionView {
  label: string;
  detail?: string;
}

/** Normalize one raw option (string | {label, detail?}) for display. */
export function choiceOption(raw: unknown): ChoiceOptionView | null {
  if (typeof raw === "string") {
    const label = raw.replace(/\s+/g, " ").trim();
    return label ? { label } : null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const label = String(o.label ?? "").replace(/\s+/g, " ").trim();
    if (!label) return null;
    const detail = typeof o.detail === "string" ? o.detail.trim() : "";
    return { label, ...(detail ? { detail } : {}) };
  }
  return null;
}

/** Normalize a raw options array (tolerates mixed/garbage entries). */
export function choiceOptions(raw: unknown): ChoiceOptionView[] {
  if (!Array.isArray(raw)) return [];
  const out: ChoiceOptionView[] = [];
  for (const item of raw) {
    const opt = choiceOption(item);
    if (opt && !out.some((x) => x.label === opt.label)) out.push(opt);
  }
  return out;
}
