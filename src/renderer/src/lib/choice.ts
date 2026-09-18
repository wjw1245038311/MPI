/**
 * Renderer-side helpers for choice rendering.
 *
 * `choiceOptions` normalizes raw option arrays (string | {label, detail}) for
 * the live select cards (ExtUiPromptCard) and the inline multi-question panel
 * (ChoicePanel via lib/choice-block.ts). `parseChoiceOutcome` parses the
 * canonical mpi_ask_choice tool-result texts that remain in OLD session
 * transcripts — the history card (Chat ChoiceToolCard) renders those read-only.
 */

/** Canonical result texts produced by the (now-removed) mpi_ask_choice tool,
 * still present in old transcripts (keep in sync with what it wrote). */
const SELECTED_ZH_RE = /^用户已选择：「(.+)」/;
const SELECTED_EN_RE = /^User selected:\s*"(.*)"/;
const CANCELLED_RE = /未做出选择|did not select/i;

export type ChoiceOutcome =
  | { kind: "selected"; value: string }
  | { kind: "cancelled" }
  | null;

/** Parse an mpi_ask_choice tool result (old transcripts) into a structured outcome. */
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
 * explanation shown in an expandable section (options may be plain strings or
 * {label, detail} objects). */
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
