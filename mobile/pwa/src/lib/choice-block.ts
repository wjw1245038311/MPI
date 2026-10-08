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

/** 一题的一个答案：预设选项或「其它」自由文本。 */
export type ChoiceAnswer = { kind: "option"; label: string } | { kind: "other"; text: string };

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
    if (seg.type !== "code" || (seg.lang ?? "") !== "choices") {
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

/** Build the combined user message sent when every question has an answer. */
export function buildChoiceReplyText(
  questions: ChoiceBlockQuestion[],
  answers: (ChoiceAnswer | null)[],
  language: "zh" | "en",
): string {
  const zh = language === "zh";
  const lines = [zh ? "我的选择：" : "My choices:"];
  questions.forEach((q, i) => {
    const a = answers[i] ?? null;
    const ans = !a
      ? zh ? "（未选）" : "(none)"
      : a.kind === "option" ? a.label : `${zh ? OTHER_PREFIX_ZH : OTHER_PREFIX_EN}${a.text}`;
    lines.push(`${i + 1}. ${q.title} → ${ans}`);
  });
  return lines.join("\n");
}

const REPLY_HEADER_RE = /^(我的选择|My choices)\s*[:：]$/i;
const REPLY_LINE_RE = /^(\d+)\s*[.、)]\s*(.+?)\s*(?:→|->)\s*(.+)$/;
const OTHER_ANSWER_RE = /^(其它|Other)\s*[:：]\s*(\S.*)$/i;

function normTitle(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Parse a user message back into per-question answers when it matches the
 * combined-reply format AND lines up with `questions` (count + titles).
 * Returns null for anything else（调用方视为「面板被普通回复取代」）。
 */
export function parseChoiceReply(rawText: unknown, questions: ChoiceBlockQuestion[]): Record<number, ChoiceAnswer> | null {
  if (typeof rawText !== "string") return null;
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !REPLY_HEADER_RE.test(lines[0])) return null;

  const out: Record<number, ChoiceAnswer> = {};
  for (let k = 1; k < lines.length; k++) {
    const m = REPLY_LINE_RE.exec(lines[k]);
    if (!m) return null;
    const idx = Number(m[1]) - 1;
    const q = questions[idx];
    if (!q || normTitle(m[2]) !== normTitle(q.title)) return null;

    const answerText = m[3].trim();
    const option = q.options.find((o) => o.label === answerText);
    if (option) {
      out[idx] = { kind: "option", label: option.label };
      continue;
    }
    const other = OTHER_ANSWER_RE.exec(answerText);
    if (other) {
      out[idx] = { kind: "other", text: other[2].trim() };
      continue;
    }
    return null; // answer matches neither an option nor the 其它 format
  }
  if (Object.keys(out).length !== questions.length) return null;
  return out;
}

// ---- 面板状态推导（从会话记录，无额外存储） -----------------------------------

export type ChoicePanelState =
  | { kind: "pending" }
  | { kind: "answered"; answers: Record<number, ChoiceAnswer> }
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
  const answers = parseChoiceReply(messageTextOf(nextUser), data.questions);
  return answers ? { kind: "answered", answers } : { kind: "superseded" };
}
