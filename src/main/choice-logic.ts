/**
 * Shared pure logic for the 方案选择 (mpi_ask_choice) feature.
 *
 * The choice extension (mpi-choice-ext.ts) is bundled into the main process as
 * a raw string and written standalone into userData, so it CANNOT import this
 * file — it carries its own copy of these small functions. Keep both in sync:
 * the title prefix is the cross-process contract that lets the renderer's
 * ExtUiPromptCard (live card) and Chat history (ChoiceToolCard), plus the main
 * process' channel auto-cancel, recognize choice requests.
 */

/** Stable title prefix written by the extension before ctx.ui.select().
 * Matched case-insensitively; full-width colon for zh, half-width tolerated too. */
export const CHOICE_TITLE_PREFIX_RE = /^(?:方案选择|Plan\s+choice)\s*[:：]/i;

export type ChoiceLanguage = "zh" | "en";

/** Build the select() heading: stable marker prefix + the agent's question. */
export function choiceHeading(language: ChoiceLanguage, question: string): string {
  const q = String(question || "").trim();
  return language === "zh" ? `方案选择：${q}` : `Plan choice: ${q}`;
}

/** True when an extension_ui_request is a plan-choice dialog (not a permission gate). */
export function isChoiceTitle(title: unknown): boolean {
  if (typeof title !== "string") return false;
  const firstLine = title.split(/\r?\n/, 1)[0].trim();
  return CHOICE_TITLE_PREFIX_RE.test(firstLine);
}

/** Remove the marker prefix so cards can show only the agent's question. */
export function stripChoicePrefix(title: string): string {
  const line = String(title || "").split(/\r?\n/, 1)[0] || "";
  return line.replace(CHOICE_TITLE_PREFIX_RE, "").trim() || line.trim();
}

/** Canonical tool-result texts (the renderer parses these back for history cards). */
export function choiceResultText(language: ChoiceLanguage, choice: string | null): string {
  if (!choice) {
    return language === "zh"
      ? "用户未做出选择（对话框已关闭）。不要擅自选择任何方案；用文字询问用户想要哪个。"
      : "The user did not select any option (dialog closed). Do NOT pick an option on your own; ask in plain text which one they want.";
  }
  return language === "zh" ? `用户已选择：「${choice}」。请按此选项继续执行。` : `User selected: "${choice}". Proceed with this option.`;
}

// ---- mode-switch request (mpi_request_mode_switch) --------------------------
// The agent asks to leave an enforced read-only task mode (e.g. research) so it
// can execute the plan it just presented. Main intercepts the dialog + response
// and performs the live switch; keep these markers in sync with mpi-choice-ext.ts.

/** Stable title prefix written by the extension before ctx.ui.select(). */
export const MODE_SWITCH_TITLE_PREFIX_RE = /^(?:模式切换请求|Mode\s+switch\s+request)\s*[:：]/i;

export function isModeSwitchTitle(title: unknown): boolean {
  if (typeof title !== "string") return false;
  const firstLine = title.split(/\r?\n/, 1)[0].trim();
  return MODE_SWITCH_TITLE_PREFIX_RE.test(firstLine);
}

/** Exact option labels the extension offers (main matches them on response). */
export const MODE_SWITCH_APPROVE_LABELS: readonly string[] = ["同意并切换", "Approve & switch"];
export const MODE_SWITCH_DENY_LABELS: readonly string[] = ["拒绝", "Deny"];
