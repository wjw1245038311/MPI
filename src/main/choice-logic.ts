/**
 * Shared pure logic for the mode-switch request (mpi_request_mode_switch).
 *
 * The bridge extension (mpi-choice-ext.ts) is bundled into the main process as
 * a raw string and written standalone into userData, so it CANNOT import this
 * file — it carries its own copy of these small functions. Keep both in sync:
 * the title prefix + option labels are the cross-process contract that lets
 * the main process recognize mode-switch dialogs and perform the live switch.
 */

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

// ---- Q&A mode instruction (Settings → 对话设置 “问答方式”) -------------------
/** System-prompt text steering how the agent asks multiple-choice questions.
 * "inline" (default): emit ```choices fences that MPI renders as clickable
 * panels; selections come back as one user message. "manual": plain-text
 * numbered questions, answers typed by hand. */
export function qaModeInstruction(mode: "inline" | "manual", language: "zh" | "en" = "zh"): string {
  const zh = language === "zh";
  if (mode === "manual") {
    return zh
      ? "## 问答方式：手动回答\n不要输出 ```choices 围栏块。向用户提问时用编号的普通文本列出问题与选项，等待用户打字作答；用户的自由回复即视为答案。"
      : '## Q&A style: manual answers\nDo NOT emit ```choices fenced blocks. Ask questions as numbered plain text with their options and wait for the user to type an answer; treat any free-form reply as the answer.';
  }
  return zh
    ? "## 问答方式：内联快速选择\n当你向用户提出带明确选项的问题（每题 2-6 个选项）时，在回复中输出一个 choices 围栏块：单独一行 ```choices，下一行 JSON 数组 [{\"title\":\"问题\",\"options\":[\"A\",\"B\"]}]（option 可为字符串或 {\"label\":\"…\",\"detail\":\"一句说明\"}），再单独一行 ```。格式硬要求：围栏里除了 JSON 不要有任何其它字符，闭合的 ``` 必须另起一行独占一行（绝不能跟在 JSON 同一行的末尾，否则整块无法渲染成面板）。MPI 会把它渲染成可点击的内联面板；用户点选后以一条「我的选择：1. … → …」消息回复，按题号处理即可。若其它指令（如访谈类 skill）要求用 ❓/编号文本呈现带选项的问题，同样改用 choices 围栏块呈现这些选项；上下文与分析仍放在围栏前的普通文字里。没有明确选项的开放性问题用普通文本提问。"
    : '## Q&A style: inline quick choice\nWhen you ask the user questions with discrete options (2-6 per question), emit a choices fence in your reply: a line ```choices, then a JSON array [{"title":"question","options":["A","B"]}] (option = string or {"label":"…","detail":"one-line note"}), then a closing ```. Hard format rules: the fence body is the JSON and nothing else, and the closing ``` must sit on its own line (never appended to the end of the JSON line — that makes the whole block unrenderable). MPI renders it as a clickable inline panel; the user\'s picks come back as one message starting with "My choices:" — handle them by question number. If another instruction (e.g. an interviewing skill) prescribes ❓/numbered text for option-bearing questions, use the choices fence for those options instead; keep context and analysis in normal text before the fence. Open-ended questions stay plain text.';
}
