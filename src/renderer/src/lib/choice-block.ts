/**
 * Inline multi-question choice blocks (对话内多题选择面板).
 *
 * When the agent asks several related decisions in one round (e.g. a grilling
 * frontier), it emits a fenced block inside its message text:
 *
 *   ```choices
 *   [{"title":"用什么方案？","options":["方案甲（推荐）","方案乙"]}]
 *   ```
 *
 * The renderer replaces the fence with an interactive panel (ChoicePanel in
 * Chat.tsx): the user picks one option per question locally ("后台记录"), and
 * once every question has an answer all selections are combined into ONE user
 * message via sendPrompt:
 *
 *   我的选择：
 *   1. 用什么方案？ → 方案甲（推荐）
 *   2. …            → 其它：<自定义>
 *
 * After that reply lands in the transcript the panel freezes and shows the
 * selections (✓); any OTHER subsequent user message also freezes it as
 * "superseded" (the user answered by typing instead). State is derived from
 * the conversation itself — nothing extra is stored, so reloads stay correct.
 *
 * The fence format + reply texts below are the contract with the grilling
 * skill and the mpi_ask_choice tool description — keep them in sync.
 */

import { choiceOptions, type ChoiceOptionView } from "./choice";
import type { ViewMessage } from "./types";

export interface ChoiceBlockQuestion {
  title: string;
  options: ChoiceOptionView[];
}

export interface ChoiceBlockData {
  questions: ChoiceBlockQuestion[];
}

/** One user answer for one question. */
export type ChoiceAnswer = { kind: "option"; label: string } | { kind: "other"; text: string };

export const MAX_QUESTIONS = 6;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const TITLE_MAX = 200;

/** Segments of one assistant text block after splitting out choice fences. */
export type ChoiceSegment =
  | { kind: "md"; text: string }
  | { kind: "choice"; data: ChoiceBlockData }
  /** A ```choices fence whose body is not valid JSON — rendered as a plain code block. */
  | { kind: "code"; text: string };

/** Opening backtick fence: capture the run length + info string. */
const FENCE_OPEN_RE = /^\s*(`{3,})(.*)$/;
/** Closing fence for a fence opened with `len` backticks (CommonMark: the
 * closer must be at least as long and carry no info string). */
const closeReFor = (len: number) => new RegExp("^\\s*`{" + len + ",}\\s*$");

/** Parse + validate the JSON body of a choices fence. Null when invalid. */
export function parseChoiceBlockData(body: string): ChoiceBlockData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).questions)
      ? ((raw as Record<string, unknown>).questions as unknown[])
      : null;
  if (!list || list.length < 1 || list.length > MAX_QUESTIONS) return null;

  const questions: ChoiceBlockQuestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const o = item as Record<string, unknown>;
    const title = String(o.title ?? "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
    if (!title) return null;
    const options = choiceOptions(o.options);
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return null;
    questions.push({ title, options });
  }
  return { questions };
}

/**
 * Split an assistant text block around ```choices fences. Fast path: blocks
 * without the marker come back as a single md segment with the ORIGINAL string
 * (identity preserved for memoization). A state machine tracks generic code
 * fences so a choices example QUOTED inside another fence is never activated.
 * Unterminated fences are left as text.
 */
export function splitChoiceSegments(text: string): ChoiceSegment[] {
  if (!/```\s*choices/i.test(text)) return [{ kind: "md", text }];

  const lines = text.split(/\r?\n/);
  const segments: ChoiceSegment[] = [];
  let buf: string[] = [];
  const flushMd = () => {
    if (buf.length) {
      segments.push({ kind: "md", text: buf.join("\n") });
      buf = [];
    }
  };

  // Fence state: null = outside; otherwise the opener's backtick run length
  // (the closer must be at least that long, per CommonMark — this is what
  // keeps a choices example quoted inside a ```` block inert).
  let fenceLen: number | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fenceLen !== null) {
      buf.push(line);
      if (closeReFor(fenceLen).test(line)) fenceLen = null;
      i++;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (!open || !/^choices[ \t]*$/i.test(open[2].trim())) {
      if (open) fenceLen = open[1].length; // generic fence — skip until its close
      buf.push(line);
      i++;
      continue;
    }
    const len = open[1].length;
    let j = i + 1;
    while (j < lines.length && !closeReFor(len).test(lines[j])) j++;
    if (j >= lines.length) {
      // Unterminated fence — treat the opening line as plain text.
      buf.push(line);
      i++;
      continue;
    }
    const body = lines.slice(i + 1, j).join("\n");
    flushMd();
    const data = parseChoiceBlockData(body);
    segments.push(data ? { kind: "choice", data } : { kind: "code", text: lines.slice(i, j + 1).join("\n") });
    i = j + 1;
  }
  flushMd();

  // Marker present but no fence matched (e.g. inside a longer word) — return
  // the original text untouched.
  if (segments.length === 1 && segments[0].kind === "md" && segments[0].text !== text) {
    return [{ kind: "md", text }];
  }
  return segments;
}

/** The visible equivalent of a choice block for the search corpus: question
 * titles + option labels (details are collapsed by default → not counted). */
export function choiceBlockVisibleText(data: ChoiceBlockData): string {
  return data.questions.map((q) => [q.title, ...q.options.map((o) => o.label)].join("\n")).join("\n");
}

/** Replace every VALID choices fence in `text` with its visible equivalent;
 * invalid fences stay as-is (they render as code blocks). */
export function choiceFenceToVisibleText(text: string): string {
  const segments = splitChoiceSegments(text);
  if (segments.length === 1 && segments[0].kind === "md") return text;
  return segments
    .map((seg) => (seg.kind === "choice" ? choiceBlockVisibleText(seg.data) : seg.text))
    .join("\n");
}

// ---- reply construction + parsing (contract with the skill/description) ----

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
    const ans = !a ? (zh ? "（未选）" : "(none)") : a.kind === "option" ? a.label : `${zh ? OTHER_PREFIX_ZH : OTHER_PREFIX_EN}${a.text}`;
    lines.push(`${i + 1}. ${q.title} → ${ans}`);
  });
  return lines.join("\n");
}

const REPLY_HEADER_RE = /^(我的选择|My choices)\s*[:：]$/i;
const REPLY_LINE_RE = /^(\d+)\s*[.、)]\s*(.+?)\s*(?:→|->)\s*(.+)$/;
const OTHER_ANSWER_RE = /^(其它|Other)\s*[:：]\s*(\S.*)$/i;

/** Normalize a title for comparison (whitespace collapse + trim). */
function normTitle(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Parse a user message back into per-question answers when it matches the
 * combined-reply format produced by buildChoiceReplyText AND lines up with
 * `questions` (count + titles). Returns null for anything else — callers treat
 * that as "the panel was superseded by a normal reply".
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
  // Every question must be answered for this to count as our reply.
  if (Object.keys(out).length !== questions.length) return null;
  return out;
}

// ---- panel state derivation -------------------------------------------------

export type ChoicePanelState =
  | { kind: "pending" }
  | { kind: "answered"; answers: Record<number, ChoiceAnswer> }
  /** A user message followed the block but is not our combined reply. */
  | { kind: "superseded" };

/**
 * Derive a panel's lifecycle state from the transcript alone (no extra
 * storage): pending until the first user message after the assistant message
 * carrying the block; then answered (✓ marks) when that message parses as our
 * combined reply, superseded otherwise.
 */
export function deriveChoicePanelState(
  messages: ViewMessage[] | undefined,
  messageKey: string,
  data: ChoiceBlockData,
): ChoicePanelState {
  if (!messages || !messages.length) return { kind: "pending" };
  const idx = messages.findIndex((m) => m.key === messageKey);
  if (idx === -1) return { kind: "pending" };
  const nextUser = messages.slice(idx + 1).find((m) => m.role === "user");
  if (!nextUser) return { kind: "pending" };
  const answers = parseChoiceReply(nextUser.text, data.questions);
  return answers ? { kind: "answered", answers } : { kind: "superseded" };
}
