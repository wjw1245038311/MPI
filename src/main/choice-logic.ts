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
  return zh ? INLINE_CHOICES_PROMPT_ZH : INLINE_CHOICES_PROMPT_EN;
}

// 提示词单独抽出来：**格式段用语言无关的骨架**（open/body/close/limit/quote 五行符号），
// 说明文字才用界面语言。原因：模型的思考语言不受提示词控制（2026-10-27 实测：系统提示全中文，
// 25 条带 choices 的回复里 24 条仍用英文思考），而格式约束本质是「形状」——用哪种语言解释
// 不该影响它照抄。分点也便于模型在长上下文里重新定位规则。
const INLINE_CHOICES_PROMPT_ZH = [
  "## 问答方式：内联快速选择",
  "",
  "需要用户从明确选项里挑一个时（每题 2-6 个选项），用 choices 围栏块提问——MPI 会渲染成可点击的面板。没有明确选项的开放问题，用普通文字问。",
  "",
  "格式（语言无关，照形状写）：",
  "  open  = 单独一行 ```choices    ← 后面不能跟任何字符（```choices> 是畸形写法）",
  '  body  = [{"title":"问题","options":["A","B"]}]   选项也可写 {"label":"文字","detail":"一句说明"}',
  "  close = 单独一行 ```           ← 必须另起一行独占一行，不能贴在 JSON 行尾",
  "  limit = 一条回复最多一个块，只写最终版（不要草稿块）；最多 6 题、每题 2-6 个选项",
  '  quote = 字符串里不要出现未转义的英文双引号 "，中文用「」代替',
  "",
  "示例：",
  "```choices",
  '[{"title":"下一步怎么走","options":["现在开始","先看方案"]}]',
  "```",
  "",
  "用户怎么答：",
  "- 点选后会收到一条以「我的选择：」开头的消息，逐行是「1. 问题 → 选项」，按题号处理。",
  "- 某题整行缺失 = 用户跳过了这题，不要再追问。",
  "- 行尾可能带「（补充：…）」，并入该题理解；用户直接打字回答也算答案。",
  "- 若其它指令（如访谈类 skill）要求用 ❓/编号文本列选项，把选项部分改成 choices 块，上下文与分析仍写在围栏前。",
].join("\n");

const INLINE_CHOICES_PROMPT_EN = [
  "## Q&A style: inline quick choice",
  "",
  "When the user needs to pick from explicit options (2-6 per question), ask with a choices fence — MPI renders it as a clickable panel. Open-ended questions without discrete options stay plain text.",
  "",
  "Format (language-neutral — copy the shape):",
  "  open  = a line with exactly ```choices    <- nothing else on it (```choices> is malformed)",
  '  body  = [{"title":"question","options":["A","B"]}]   an option can be {"label":"text","detail":"one-line note"}',
  "  close = a line with exactly ```           <- must sit on its own line, never glued to a JSON line",
  "  limit = at most ONE block per reply, final version only (no draft block); max 6 questions, 2-6 options each",
  "  quote = never leave an unescaped double quote inside a string — use typographic quotes",
  "",
  "Example:",
  "```choices",
  '[{"title":"What next?","options":["Start now","Review the plan first"]}]',
  "```",
  "",
  "How the reply comes back:",
  '- After clicking, you get one message starting with "My choices:" — one line per question as "1. question → option". Handle it by question number.',
  "- A missing line means the user skipped that question: do not re-ask it.",
  '- A trailing "(note: …)" belongs to that question; free-form typed answers count too.',
  "- If another instruction (e.g. an interviewing skill) prescribes ❓/numbered text for option-bearing questions, use a choices fence for those options and keep the context/analysis in normal text before the fence.",
].join("\n");
