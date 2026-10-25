/**
 * 手机端 choices 面板逻辑（桌面端 src/renderer/src/lib/choice-block.ts 的移植）。
 *
 * agent 在回复里输出 ```choices 围栏块（JSON 数组：[{title, options}]），
 * 桌面端渲染成可点击的多题选择面板；手机端此前只会把它当普通代码块打印 JSON。
 * 本文件提供解析 + 回复构造 + 状态推导的纯逻辑，UI 在 components/ChoicePanel.tsx。
 *
 * 与桌面端保持同一份「契约」（围栏格式、回复文本、状态语义）：
 *   - 用户点选后以一条「我的选择：\n1. 题 → 选项」消息发出（buildChoiceReplyText）；
 *   - 面板状态完全从会话记录推导（deriveChoicePanelState），不额外存储——
 *     该 assistant 消息后的第一条 user 消息若能解析成组合回复 = answered，否则 superseded。
 *
 * mobile 特有：parseSegments（markdown-lite.ts）只按 ``` 行切段、不做围栏容错，
 * 而模型常把闭合围栏粘在 JSON 行尾或干脆漏写（deepseek 系尤甚）。桌面端在
 * splitChoiceSegments 里做了三级容错；手机端等价逻辑放在 withChoiceSegments——
 * 仅当正文能解析成合法 choices JSON 时才采纳，否则降级为代码块 + 提示行。
 *
 * 已知差异：parseSegments 不跟踪嵌套围栏，所以「另一个代码块里引用的 choices
 * 示例」在手机上会被当成真面板（桌面端有 fence state 保护）。属罕见场景，接受。
 *
 * lang 判定与桌面端同步分两档（2026-10-12）：精确档 `choices` 允许尾随噪声
 * （模型把开围栏写成 ```choices> 时，markdown-lite 给出的 lang 是 `choices>`，
 * 旧判定会静默降级成代码块）；疑似档（choicesjson 等）仅当正文严格解析通过
 * 才升级。手机端无诊断日志通道，所以不上报笔误形态（桌面端有 choice-fence-info）。
 */

import type { TextSegment } from "./markdown-lite";

// ---- 类型（与桌面端同名同形） ----------------------------------------------

export interface ChoiceOptionView {
  label: string;
  detail?: string;
}

export interface ChoiceBlockQuestion {
  title: string;
  options: ChoiceOptionView[];
}

export interface ChoiceBlockData {
  questions: ChoiceBlockQuestion[];
  /** 题目/选项超出上限被截断的数量（>0 时面板下方给一行说明）。 */
  clamped?: ChoiceClampInfo;
}

/** 超出上限被截断的计数（>0 时面板下方给一行说明，对齐桌面端）。 */
export interface ChoiceClampInfo {
  questions: number;
  options: number;
}

/** choices 围栏正文解析失败的原因（精确降级提示用，对齐桌面端）。 */
export type ChoiceFailure = "syntax" | "shape";

/**
 * 一题的一个答案（与桌面端同一契约）。
 * - option：预设选项；other：自定义文本；skip：跳过这题。
 * - note：可选「补充说明」（≤200 字），与答案并存。
 *   跳过的题默认不回传给模型；只有写了补充才回传一行「2. → 补充：…」。
 */
export type ChoiceAnswer =
  | { kind: "option"; label: string; note?: string }
  | { kind: "other"; text: string; note?: string }
  | { kind: "skip"; note?: string };

/** 补充说明的长度上限（输入与回传双层截断）。 */
export const CHOICE_NOTE_MAX = 200;

const MAX_QUESTIONS = 6;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const TITLE_MAX = 200;

// ---- 选项归一化（string | {label, detail}） ---------------------------------

function choiceOption(raw: unknown): ChoiceOptionView | null {
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

function choiceOptions(raw: unknown): ChoiceOptionView[] {
  if (!Array.isArray(raw)) return [];
  const out: ChoiceOptionView[] = [];
  for (const item of raw) {
    const opt = choiceOption(item);
    if (opt && !out.some((x) => x.label === opt.label)) out.push(opt);
  }
  return out;
}

// ---- 围栏正文解析（严格 + 容错） --------------------------------------------

/** Parse the JSON body of a choices fence and validate/shape it. Null when invalid. */
export function parseChoiceBlockData(body: string): ChoiceBlockData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  return choiceDataFromJson(raw);
}

/**
 * 结构校验 + 超限截断（不做 JSON 解析——修复链会对同一份数据反复调用它）。
 * 超限不再整块判非法（对齐桌面端）：截断渲染 + clamped 计数。
 */
function choiceDataFromJson(raw: unknown): ChoiceBlockData | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).questions)
      ? ((raw as Record<string, unknown>).questions as unknown[])
      : null;
  if (!list || list.length < 1) return null;

  let droppedQuestions = Math.max(0, list.length - MAX_QUESTIONS);
  let droppedOptions = 0;
  const questions: ChoiceBlockQuestion[] = [];
  for (const item of list.slice(0, MAX_QUESTIONS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      droppedQuestions++;
      continue;
    }
    const o = item as Record<string, unknown>;
    const title = String(o.title ?? "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
    if (!title) {
      droppedQuestions++;
      continue;
    }
    let options = choiceOptions(o.options);
    if (options.length > MAX_OPTIONS) {
      droppedOptions += options.length - MAX_OPTIONS;
      options = options.slice(0, MAX_OPTIONS);
    }
    if (options.length < MIN_OPTIONS) {
      droppedQuestions++;
      continue;
    }
    questions.push({ title, options });
  }
  if (!questions.length) return null;
  return droppedQuestions || droppedOptions
    ? { questions, clamped: { questions: droppedQuestions, options: droppedOptions } }
    : { questions };
}

/** 截出正文里第一个括号配对的 JSON 值（跳过字符串内的括号与转义）。 */
function sliceFirstJson(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") stack.push("]");
    else if (ch === "{") stack.push("}");
    else if (ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return null;
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * JSON 修复链（与桌面端逐字对齐）：① 字符串里未转义的英文双引号；② 结尾少括号；
 * ③ options 里丢了 `{}` 包裹的裸 `"label":…` 对。仅在严格解析失败后启用，
 * 结果必须能过 choiceDataFromJson 的结构校验才采纳。
 * 依据 2026-10 对全部历史会话的盘点（498 个 choices 围栏 / 5 个失败）。
 */
function escapeStrayQuotes(src: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        esc = true;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j])) j++;
        const nxt = src[j];
        if (nxt === undefined || nxt === "," || nxt === ":" || nxt === "}" || nxt === "]") {
          out += ch;
          inStr = false;
          continue;
        }
        out += '\\"';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

function closeOpenBrackets(src: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = src;
  if (inStr) out += '"';
  while (stack.length) out += stack.pop();
  return out;
}

function dropTrailingCommas(src: string): string {
  return src.replace(/,(\s*[}\]])/g, "$1");
}

/** 读一个 JSON 字符串键：返回 key 或 null（key 后须跟 `:`）。 */
function peekKey(src: string, i: number): string | null {
  if (src[i] !== '"') return null;
  let j = i + 1;
  let esc = false;
  let key = "";
  for (; j < src.length; j++) {
    const c = src[j];
    if (esc) {
      key += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') break;
    key += c;
  }
  if (j >= src.length) return null;
  let k = j + 1;
  while (k < src.length && /\s/.test(src[k])) k++;
  return src[k] === ":" ? key : null;
}

/** ③ 裸 `"label":…` 对（options 里丢了 `{}` 包裹）→ 自动补 `{}`。 */
function wrapBareLabelPairs(src: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let wrapDepth = -1;
  let prevSig = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        prevSig = '"';
      }
      continue;
    }
    if (ch === '"') {
      const elementPos = stack.length > 0 && stack[stack.length - 1] === "]" && (prevSig === "[" || prevSig === ",");
      if (elementPos && wrapDepth < 0 && peekKey(src, i) === "label") {
        out += "{";
        wrapDepth = stack.length;
      }
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "[") {
      stack.push("]");
      out += ch;
      prevSig = "[";
      continue;
    }
    if (ch === "{") {
      stack.push("}");
      out += ch;
      prevSig = "{";
      continue;
    }
    if (ch === "]" || ch === "}") {
      if (wrapDepth === stack.length) {
        out += "}";
        wrapDepth = -1;
      }
      stack.pop();
      out += ch;
      prevSig = ch;
      continue;
    }
    if (ch === ",") {
      if (wrapDepth >= 0 && wrapDepth === stack.length && peekKey(src, i + 1) === "label") {
        out += "},{";
        prevSig = "{";
        continue;
      }
      out += ch;
      prevSig = ",";
      continue;
    }
    if (!/\s/.test(ch)) prevSig = ch;
    out += ch;
  }
  if (wrapDepth >= 0) out += "}";
  return out;
}

function repairChain(src: string): string {
  return dropTrailingCommas(closeOpenBrackets(wrapBareLabelPairs(escapeStrayQuotes(src))));
}

function repairCandidates(body: string): string[] {
  const trimmed = body.trim();
  const sliced = sliceFirstJson(trimmed);
  const out = [sliced ?? "", repairChain(trimmed)];
  if (sliced) out.push(repairChain(sliced));
  return out.filter((c) => c.length > 0);
}

/** 解析围栏正文（容错版）：严格 parse → 截出第一个完整 JSON → 修复链。 */
function parseChoiceBodyEx(body: string): { data: ChoiceBlockData | null; failure?: ChoiceFailure; repaired?: boolean } {
  const direct = parseChoiceBlockData(body.trim());
  if (direct) return { data: direct };

  let sawJson = false;
  for (const candidate of repairCandidates(body)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    sawJson = true;
    const data = choiceDataFromJson(parsed);
    if (data) return { data, repaired: true };
  }
  return { data: null, failure: sawJson ? "shape" : "syntax" };
}

/** 仅用于「忘了写闭合围栏」时的边界判定：必须严格能解析才认，不开修复链……
 * 否则自动补括号会让一段普通正文被误当成面板。 */
function parseChoiceBodyBoundary(body: string): ChoiceBlockData | null {
  const direct = parseChoiceBlockData(body.trim());
  if (direct) return direct;
  const sliced = sliceFirstJson(body);
  return sliced ? parseChoiceBlockData(sliced) : null;
}

// ---- 与 parseSegments 的集成 -------------------------------------------------

/** 行尾挂着 ≥3 个反引号的行（模型把闭合围栏粘在正文末尾时）；捕获反引号之前的正文。 */
const GLUED_CLOSE_RE = /^(.*?)`{3,}\s*$/;

/** 精确档 lang（markdown-lite 已 trim + 小写）：`choices` 或带尾随噪声的笔误
 *  （`choices>` / `choices:`）——与桌面端 isChoicesInfoString 同一规则。 */
const CHOICES_LANG_RE = /^choices[^a-z0-9_-]*$/;
/** 疑似档：以 choices 开头的其它标签（choicesjson / choices_v2 等），
 *  只有正文严格解析通过才升级成面板（不开修复链）。 */
const CHOICES_LIKE_RE = /^choices/;

/** 代码段的 lang 是否应视为 choices 围栏。 */
export function isChoicesLang(lang: string | undefined): boolean {
  return CHOICES_LANG_RE.test((lang ?? "").trim().toLowerCase());
}

export type ChoiceAwareSegment =
  | { kind: "text"; text: string }
  /** choiceWarn：choices 围栏解析失败，按代码块显示并附一行提示（对齐桌面端）。
   * failReason/raw 供具体原因文案与上层诊断（可选，与桌面端同形）。 */
  | { kind: "code"; text: string; lang?: string; closed?: boolean; choiceWarn?: boolean; failReason?: ChoiceFailure }
  /** repaired：这份数据是靠修复链救回来的（对齐桌面端，便于以后统计）。 */
  | { kind: "choice"; data: ChoiceBlockData; repaired?: boolean };

/**
 * 把 parseSegments 的输出转成可渲染段：合法的 choices 围栏升级为面板。
 *
 * - finalized=false（流式中）：原样返回——围栏保持代码块，定稿后才变面板
 *   （与桌面端一致；也避免流式中间态反复解析）。
 * - finalized=true：对每个 lang==="choices" 的代码段做容错解析：
 *     1) 正常闭合（含正文尾部挂垃圾）→ choice 段；
 *     2) 未闭合 = 模型把 ``` 粘在 JSON 行尾 → 找到粘行处，围栏后剩余文本还原为 text 段；
 *     3) 漏写闭合围栏 → 整体当正文（剥掉可能的行尾反引号）；
 *     4) 都失败 → 保持代码块 + choiceWarn。
 */
export function withChoiceSegments(segments: TextSegment[], finalized: boolean): ChoiceAwareSegment[] {
  if (!finalized) return segments.map(toPlainSegment);

  const out: ChoiceAwareSegment[] = [];
  for (const seg of segments) {
    if (seg.type !== "code") {
      out.push(toPlainSegment(seg));
      continue;
    }
    const lang = (seg.lang ?? "").trim().toLowerCase();
    const exact = CHOICES_LANG_RE.test(lang);
    const like = !exact && CHOICES_LIKE_RE.test(lang);
    if (!exact && !like) {
      out.push(toPlainSegment(seg));
      continue;
    }
    // 疑似档（标签写歪）：正文严格解析不过就维持普通代码块，不抢普通 json 块。
    if (like && !parseChoiceBodyBoundary(seg.text)) {
      out.push(toPlainSegment(seg));
      continue;
    }

    // 1) 已闭合：整体容错解析（严格 → 截第一个 JSON → 修复链）。
    if (seg.closed !== false) {
      const r = parseChoiceBodyEx(seg.text);
      out.push(
        r.data
          ? { kind: "choice", data: r.data, ...(r.repaired ? { repaired: true } : {}) }
          : { kind: "code", text: seg.text, lang: seg.lang, closed: seg.closed, choiceWarn: true, ...(r.failure ? { failReason: r.failure } : {}) },
      );
      continue;
    }

    // 2) 定稿了仍未闭合：粘行闭合扫描（只接受正文能解析成合法 JSON 的边界）。
    const lines = seg.text.split("\n");
    let glued = false;
    for (let k = 0; k < lines.length && !glued; k++) {
      const m = GLUED_CLOSE_RE.exec(lines[k]);
      if (!m) continue;
      const r = parseChoiceBodyEx([...lines.slice(0, k), m[1]].join("\n"));
      if (!r.data) continue;
      out.push({ kind: "choice", data: r.data, ...(r.repaired ? { repaired: true } : {}) });
      const rest = lines.slice(k + 1).join("\n");
      if (rest.trim()) out.push({ kind: "text", text: rest });
      glued = true;
    }
    if (glued) continue;

    // 3) 漏写闭合围栏：整体当正文（剥掉可能的行尾反引号）。
    //    这里必须用严格边界判定（不开修复链）——否则自动补括号会把一段普通正文误当成面板。
    const data = parseChoiceBodyBoundary(lines.join("\n").replace(/`{3,}\s*$/, ""));
    out.push(
      data ? { kind: "choice", data } : { kind: "code", text: seg.text, lang: seg.lang, closed: false, choiceWarn: true },
    );
  }
  return out;
}

function toPlainSegment(seg: TextSegment): ChoiceAwareSegment {
  if (seg.type === "code") return { kind: "code", text: seg.text, lang: seg.lang, closed: seg.closed };
  return { kind: "text", text: seg.text };
}

// ---- 回复构造 + 解析（与桌面端同一契约） -------------------------------------

const OTHER_PREFIX_ZH = "其它：";
const OTHER_PREFIX_EN = "Other: ";

// 跳过的题默认**整行省略**（用户 2026-10-25 要求：前题选项与后题无关时，「题目都
// 不用给了」）；全部跳过时至少留一行 `（全部跳过）`，免得模型收到只有标题头的消息。
// 「补充说明」是**整组题目**的补充（不是每题一个），写在最后一题之后：`补充：…`。

/**
 * 解析结果：逐题答案 + 整组的补充说明。
 * 兼容旧格式：选项行尾的 `（补充：…）` 与「N. → 补充：…」仍会被解析成该题的 note。
 */
export interface ChoiceReply {
  answers: Record<number, ChoiceAnswer>;
  /** 整组题目的补充说明（最后一题之后的那一行）。 */
  note?: string;
}

/** Build the combined user message sent when every question has an answer. */
export function buildChoiceReplyText(
  questions: ChoiceBlockQuestion[],
  answers: (ChoiceAnswer | null)[],
  language: "zh" | "en",
  panelNote?: string,
): string {
  const zh = language === "zh";
  const lines = [zh ? "我的选择：" : "My choices:"];
  let emitted = 0;
  questions.forEach((q, i) => {
    const a = answers[i] ?? null;
    const note = (a && "note" in a ? a.note : "")?.slice(0, CHOICE_NOTE_MAX).trim();
    if (a?.kind === "skip") {
      if (note) {
        lines.push(`${i + 1}. → ${zh ? "补充：" : "Note: "}${note}`);
        emitted++;
      }
      return;
    }
    const ans = !a
      ? zh
        ? "（未选）"
        : "(none)"
      : a.kind === "option"
        ? a.label
        : `${zh ? OTHER_PREFIX_ZH : OTHER_PREFIX_EN}${a.text}`;
    const suffix = note ? (zh ? `（补充：${note}）` : ` (note: ${note})`) : "";
    lines.push(`${i + 1}. ${q.title} → ${ans}${suffix}`);
    emitted++;
  });
  if (!emitted) lines.push(zh ? "（全部跳过）" : "(all skipped)");
  const whole = (panelNote ?? "").slice(0, CHOICE_NOTE_MAX).trim();
  if (whole) lines.push(`${zh ? "补充：" : "Note: "}${whole}`);
  return lines.join("\n");
}

const REPLY_HEADER_RE = /^(我的选择|My choices)\s*[:：]$/i;
/** 标题允许为空：跳过 + 补充的行是 `2. → 补充：…`。 */
const REPLY_LINE_RE = /^(\d+)\s*[.、)]\s*(.*?)\s*(?:→|->)\s*(.+)$/;
const OTHER_ANSWER_RE = /^(其它|Other)\s*[:：]\s*(\S.*)$/i;
const SKIP_ANSWER_RE = /^(已跳过|跳过|skipped)$/i;
const ALL_SKIP_RE = /^(（全部跳过）|\(all skipped\))$/i;
const NOTE_SUFFIX_ZH_RE = /（补充[：:]\s*([\s\S]*?)）\s*$/;
const NOTE_SUFFIX_EN_RE = /\(note\s*[:：]\s*([\s\S]*?)\)\s*$/i;
const NOTE_ONLY_RE = /^(补充|Note)\s*[:：]\s*([\s\S]*)$/i;

function normTitle(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

/** 拆出答案尾部的补充说明；没有则原样返回。 */
function splitAnswerNote(text: string): { main: string; note: string } {
  const zh = NOTE_SUFFIX_ZH_RE.exec(text);
  if (zh) return { main: text.slice(0, zh.index).trim(), note: zh[1].trim() };
  const en = NOTE_SUFFIX_EN_RE.exec(text);
  if (en) return { main: text.slice(0, en.index).trim(), note: en[1].trim() };
  return { main: text.trim(), note: "" };
}

/** 整组补充那一行：没有题号（带题号的是 `2. → 补充：…`，走 REPLY_LINE_RE）。 */
const PANEL_NOTE_RE = /^(补充|Note)\s*[:：]\s*(.+)$/i;

/**
 * Parse a user message back into per-question answers (+ 整组补充) when it
 * matches the combined-reply format produced by buildChoiceReplyText。
 *
 * 没出现的题 = 「跳过」（build 侧省略了它们）。返回 null 表示这条消息不是我们
 * 的组合回复（调用方按「面板被取代」处理）。
 */
export function parseChoiceReply(rawText: unknown, questions: ChoiceBlockQuestion[]): ChoiceReply | null {
  if (typeof rawText !== "string") return null;
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !REPLY_HEADER_RE.test(lines[0])) return null;

  const out: Record<number, ChoiceAnswer> = {};
  let panelNote = "";
  for (let k = 1; k < lines.length; k++) {
    if (ALL_SKIP_RE.test(lines[k])) {
      questions.forEach((_q, i) => {
        out[i] = { kind: "skip" };
      });
      continue;
    }
    // 整组补充：单独一行 `补充：…`（没有题号）。
    const whole = PANEL_NOTE_RE.exec(lines[k]);
    if (whole) {
      panelNote = whole[2].trim().slice(0, CHOICE_NOTE_MAX);
      continue;
    }
    const m = REPLY_LINE_RE.exec(lines[k]);
    if (!m) return null;
    const idx = Number(m[1]) - 1;
    const q = questions[idx];
    if (!q) return null;
    const title = m[2].trim();
    const { main, note } = splitAnswerNote(m[3].trim());

    if (!title) {
      // 省略标题：只接受 `2. → 补充：…`（跳过 + 一句原因，旧格式兼容）。
      const only = NOTE_ONLY_RE.exec(main);
      if (!only || !only[2].trim()) return null;
      out[idx] = { kind: "skip", note: only[2].trim().slice(0, CHOICE_NOTE_MAX) };
      continue;
    }
    if (normTitle(title) !== normTitle(q.title)) return null;

    const option = q.options.find((o) => o.label === main);
    if (option) {
      out[idx] = note ? { kind: "option", label: option.label, note } : { kind: "option", label: option.label };
      continue;
    }
    if (SKIP_ANSWER_RE.test(main)) {
      out[idx] = note ? { kind: "skip", note } : { kind: "skip" };
      continue;
    }
    const other = OTHER_ANSWER_RE.exec(main);
    if (other) {
      out[idx] = note ? { kind: "other", text: other[2].trim(), note } : { kind: "other", text: other[2].trim() };
      continue;
    }
    return null; // answer matches neither an option nor a known format
  }
  // 没出现的题 = 跳过（build 侧省略了它们）。
  for (let i = 0; i < questions.length; i++) {
    if (!(i in out)) out[i] = { kind: "skip" };
  }
  return panelNote ? { answers: out, note: panelNote } : { answers: out };
}

// ---- 面板状态推导（从会话记录，无额外存储） -----------------------------------

export type ChoicePanelState =
  | { kind: "pending" }
  | { kind: "answered"; answers: Record<number, ChoiceAnswer>; note?: string }
  /** A user message followed the block but is not our combined reply. */
  | { kind: "superseded" };

/** 结构化的最小消息形状（thread-session 的 ViewMessage 天然兼容）。 */
export interface ChoiceTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  blocks?: Array<{ type: string; text?: string }>;
}

function messageTextOf(m: ChoiceTranscriptMessage): string {
  return (m.blocks ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * Derive a panel's lifecycle state from the transcript alone: pending until
 * the first user message after the assistant message carrying the block; then
 * answered when that message parses as our combined reply, superseded otherwise.
 */
export function deriveChoicePanelState(
  messages: ChoiceTranscriptMessage[] | undefined,
  messageId: string,
  data: ChoiceBlockData,
): ChoicePanelState {
  if (!messages || !messages.length) return { kind: "pending" };
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return { kind: "pending" };
  const nextUser = messages.slice(idx + 1).find((m) => m.role === "user");
  if (!nextUser) return { kind: "pending" };
  const reply = parseChoiceReply(messageTextOf(nextUser), data.questions);
  return reply
    ? { kind: "answered", answers: reply.answers, ...(reply.note ? { note: reply.note } : {}) }
    : { kind: "superseded" };
}
