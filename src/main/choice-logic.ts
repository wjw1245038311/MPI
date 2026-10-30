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
      ? "## 问答方式：手动回答\n不要输出 ```choices 块。提问用编号文本列问题与 2-6 个选项，用户打字作答。需要用户决策或确定下一步时，用编号文本列清选项并写明「等你回答后我继续」，不要用开放式问句收尾。"
      : '## Q&A style: manual answers\nDo NOT emit ```choices fenced blocks. Ask with numbered text: the question plus 2-6 options; the user types the answer. When the user must decide something or pick the next step, list the options as numbered text and say "I will continue once you answer" — never end with a bare open-ended question.';
  }
  return zh ? INLINE_CHOICES_PROMPT_ZH : INLINE_CHOICES_PROMPT_EN;
}

// 提示词单独抽出来：**格式段只给形状**（一个最小可抄的示例 + 三条硬约束），说明文字才用界面语言。
// 原因：模型的思考语言不受提示词控制（2026-10-27 实测：系统提示全中文，25 条带 choices 的
// 回复里 24 条仍用英文思考），而格式约束本质是「形状」——用哪种语言解释不该影响它照抄。
// 2026-10-30 精简：原版 21 行（open/body/close/limit/quote 五行符号表 + 逐条「用户怎么答」）。
// 提示词本身也是上下文负担——越长越容易被长上下文淡化，也不好维护；而且模型不知道
// 客户端叫什么，不写「MPI 会渲染成面板」这种客端解释，直接给规则和格式。现在是 13 行。
const INLINE_CHOICES_PROMPT_ZH = [
  "## 问答方式：内联快速选择",
  "",
  "需要用户决策、确定下一步怎么走或多选问答时，用 choices 围栏收尾（不要用正文问句收尾）。纯讨论的问题用普通文字。",
  "",
  "格式（照抄）：",
  "```choices",
  '[{"title":"问题","options":["A",{"label":"B","detail":"一句说明"}]}]',
  "```",
  "- 开围栏只写 ```choices，收尾 ``` 各自独占一行（不要写 ```choices> 或 ```json）。",
  "- 一条回复最多一个块，只写最终版（不要草稿块）。",
  "- label 必填；字符串里不要有未转义的英文双引号，中文用「」。",
  "",
  "用户点选后回「我的选择：1. 问题 → 选项」，缺行 = 跳过，打字也算答案。",
].join("\n");

const INLINE_CHOICES_PROMPT_EN = [
  "## Q&A style: inline quick choice",
  "",
  "When the user must decide something, pick the next step, or answer a multi-choice question, end with a choices fence — never with a bare open-ended question. Purely exploratory questions stay plain text.",
  "",
  "Format (copy this):",
  "```choices",
  '[{"title":"question","options":["A",{"label":"B","detail":"one-line note"}]}]',
  "```",
  "- Opening fence is exactly ```choices and closing fence exactly ```, each on its own line (not ```choices> or ```json).",
  "- At most ONE block per reply, final version only (no draft block).",
  "- label is required; no unescaped double quotes inside strings.",
  "",
  'A click sends back "My choices: 1. question → option". A missing line means skipped; a typed reply counts too.',
].join("\n");
