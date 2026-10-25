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
 * skill (and any agent instructions that emit these blocks) — keep in sync.
 *
 * 闭合围栏以 CommonMark 严格形态为准（独占一行、反引号数 ≥ 开围栏），但模型
 * 常把闭合反引号粘在最后一行 JSON 末尾（deepseek 系尤甚），严格判定会判成
 * 「围栏未闭合」而整块降级成普通代码块。因此这里对 choices 围栏额外做容错：
 * 粘行闭合 / 反引号数不匹配 / 干脆忘了闭合 都接受，但**仅当正文能解析成合法
 * choices JSON** 时才采纳，否则退回原行为（普通文本 / 降级代码块）。
 *
 * info string 的判定分两档（2026-10-12：模型把开围栏写成 ```choices> 时整块静默
 * 降级成代码块，既没有面板也没有提示，只能靠用户截图反馈）：
 *   ① 精确档 `isChoicesInfoString`：`choices` 加尾随空白或非字母数字噪声
 *      （`choices>` / `choices:` / `Choices`）——按标准 choices 围栏处理；
 *      但 `choicesjson` / `choices_block` 这类「另一个标签」不算。
 *   ② 疑似档（以 choices 开头但带字母，如 `choicesjson`）：只有正文**严格**
 *      解析通过才升级为面板（不开修复链），否则维持原行为当普通围栏。
 * 两档里 info string 不等于标准 `choices` 的，段上带 `info` 字段，由 Chat.tsx
 * 写一行诊断日志（choice-fence-info），便于以后看哪些笔误形态真的出现过。
 *
 * 再往里一层是「JSON 修复链」（见 repairCandidates）：模型偶尔把正文写成
 * 语法非法的 JSON（中文串里夹未转义的英文双引号、结尾少括号、options 里丢
 * `{}` 包裹），严格 parse 必挂。修复链只在严格解析失败后启用，且修复结果必须
 * 再通过结构校验才采纳——修不出来就维持降级（并给出精确原因 + 原始正文入
 * 诊断日志），绝不把普通正文吞成面板。
 */

import { choiceOptions, type ChoiceOptionView } from "./choice";
import type { ViewMessage } from "./types";

export interface ChoiceBlockQuestion {
  title: string;
  options: ChoiceOptionView[];
}

/** 超出上限被截断的计数（>0 时面板下方给一行说明）。 */
export interface ChoiceClampInfo {
  questions: number;
  options: number;
}

/** choices 围栏正文解析失败的原因（精确降级提示 + 诊断日志用）。 */
export type ChoiceFailure = "syntax" | "shape";

export interface ChoiceBlockData {
  questions: ChoiceBlockQuestion[];
  /** 题目/选项超出上限被截断的数量（>0 时面板下方给一行说明）。 */
  clamped?: ChoiceClampInfo;
}

/**
 * 一题的一个答案。
 * - option：预设选项；other：自定义文本；skip：跳过这题。
 * - note：可选「补充说明」（≤200 字符），与答案并存——模型给的问题不够完善时用。
 *   跳过的题默认不回传给模型（用户要求「题目都不用给了」）；只有写了补充才回传
 *   一行「2. → 补充：…」，否则整行省略。
 */
export type ChoiceAnswer =
  | { kind: "option"; label: string; note?: string }
  | { kind: "other"; text: string; note?: string }
  | { kind: "skip"; note?: string };

/** 补充说明的长度上限（面板输入与回传双层截断）。 */
export const CHOICE_NOTE_MAX = 200;

export const MAX_QUESTIONS = 6;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const TITLE_MAX = 200;

/** Segments of one assistant text block after splitting out choice fences. */
export type ChoiceSegment =
  | { kind: "md"; text: string }
  /** repaired=true：这份数据是靠修复链救回来的（诊断日志用，便于以后收紧规则）。 */
  | { kind: "choice"; data: ChoiceBlockData; repaired?: boolean; raw?: string;
      /** 开围栏的 info string 不是标准 `choices`（`choices>` / `Choices` / `choicesjson`），
       *  靠容错判定才升级成面板——诊断日志据此统计模型的真实笔误形态。 */
      info?: string }
  /** A ```choices fence whose body is not valid JSON — rendered as a plain code block
   * (Chat.tsx 会在其下方给一行「未渲染成面板」提示；reason/raw 供文案与诊断日志). */
  | { kind: "code"; text: string; reason?: ChoiceFailure; raw?: string };

/** Opening backtick fence: capture the run length + info string. */
const FENCE_OPEN_RE = /^\s*(`{3,})(.*)$/;
/** Closing fence for a fence opened with `len` backticks (CommonMark: the
 * closer must be at least as long and carry no info string). */
const closeReFor = (len: number) => new RegExp("^\\s*`{" + len + ",}\\s*$");
/** 行尾挂着 ≥3 个反引号的行（模型把闭合围栏粘在正文末尾时）；捕获反引号之前的正文。 */
const GLUED_CLOSE_RE = /^(.*?)`{3,}\s*$/;
/** 精确档 info string：`choices` + 尾随空白或非字母数字噪声（`choices>` 等笔误）。
 *  故意不接受 `choicesjson` / `choices-2` 这类「另一个标签」——它们走疑似档。 */
const CHOICES_INFO_RE = /^choices[^a-z0-9_-]*$/i;
/** 疑似档：以 choices 开头的其它标签（模型把语言标签写歪）。 */
const CHOICES_LIKE_RE = /^choices/i;

/** info string 是否应视为 choices 围栏（`choices` / `choices>` / `Choices` 都算）。 */
export function isChoicesInfoString(info: string | undefined): boolean {
  return CHOICES_INFO_RE.test((info ?? "").trim());
}

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
 *
 * 超限（>MAX_QUESTIONS 题 / >MAX_OPTIONS 个选项）**不再整块判非法**：模型偶尔
 * 会多写一题或一个选项，此前整块降级成代码块、面板直接不出现，而用户看到的
 * 提示是「格式不合法」——误导。现在改成截断渲染 + `clamped` 计数（面板下方
 * 说明被截掉了多少），只有「一题都留不下来」才返回 null。
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

/**
 * 定位一个 choices 围栏的闭合位置并解析正文（容错版，见文件头注释）。
 * 返回 null 表示「连容错都用不上」——调用方按未闭合围栏处理（原样文本）。
 * `end` 是闭合行的下标；正文解析失败时 `data` 为 null（降级为代码块）。
 */
/**
 * 截出正文里第一个括号配对的 JSON 值（跳过字符串内的括号与转义）。
 * 用于正文被尾部垃圾污染时：只要前面那段 JSON 合法，就仍然认它。
 */
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
 * ---- JSON 修复链（模型把 JSON 写坏时的最后一道网）----
 *
 * 全部只在严格解析失败后才启用，结果必须能通过 chooseDataFromJson 的结构校验才采纳。
 * 依据 2026-10 对全部历史会话的盘点（498 个 choices 围栏 / 5 个失败）实践出来的三类：
 *   ① 字符串里夹未转义的英文双引号（中文串里常发生）→ escapeStrayQuotes
 *   ② JSON 结尾被写短（少了 `}`/`]`）→ closeOpenBrackets
 *   ③ options 里丢了 `{}` 包裹的裸 `"label":…` 对 → wrapBareLabelPairs
 * 三类之外（真正乱七八糟的）修不出来，维持原行为。
 */

/** 字符串内裸露的英文双引号（未转义）→ 补转义。
 * 判据：字符串内遇到 `"` 时看它后面第一个非空白字符——是 `,` `:` `}` `]`
 * 或没有字符，才算字符串正常结束；否则按字面量转义。 */
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

/** 结尾括号补齐（模型把 JSON 写短了：`…"}]` 其实少了 `}`），顺便收尾未闭合的字符串。 */
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

/** 结尾多余逗号（尾逗号，严格 JSON 不允许）。 */
function dropTrailingCommas(src: string): string {
  return src.replace(/,(\s*[}\]])/g, "$1");
}

/** 读一个 JSON 字符串键：返回 {key} 或 null（key 后须跟 `:`）。 */
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

/** ③ 裸 `"label":…` 对（options 数组里丢了 `{}` 包裹）→ 自动补 `{}`。
 * 规则：数组元素位置上出现 `"label":` 视为对象开头；同一对象内再遇 `"label":`
 * 视为新对象（`"detail":` 归当前对象）。 */
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

/** 三段修复的组合（顺序：先转义引号，再补包裹，最后补括号/去尾逗号）。 */
function repairChain(src: string): string {
  return dropTrailingCommas(closeOpenBrackets(wrapBareLabelPairs(escapeStrayQuotes(src))));
}

/** 修复候选（改动越小越先试；全部由调用方做 JSON.parse + 结构校验）。 */
function repairCandidates(body: string): string[] {
  const trimmed = body.trim();
  const sliced = sliceFirstJson(trimmed);
  const out = [sliced ?? "", repairChain(trimmed)];
  if (sliced) out.push(repairChain(sliced));
  return out.filter((c) => c.length > 0);
}

/**
 * 解析围栏正文（容错版）：严格 parse → 截出第一个完整 JSON → 修复链。
 * `failure` 仅在真的没救时给出（syntax = JSON 没解析出来；shape = 解析出来了但结构不符）。
 *
 * 为什么先「截第一个 JSON」：模型偶尔把闭合围栏吐成特殊 token（类似 `<` + 标签名
 * + `>` 的控制标记），正文尾部挂上非 JSON 行，严格 parse 必失败。
 */
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

/** 仅用于「忘了写闭合围栏」时的边界判定：必须严格能解析（含截第一个 JSON）才认，
 * 不开修复链——否则自动补括号会让一段普通正文被误当成面板。 */
function parseChoiceBodyBoundary(body: string): ChoiceBlockData | null {
  const direct = parseChoiceBlockData(body.trim());
  if (direct) return direct;
  const sliced = sliceFirstJson(body);
  return sliced ? parseChoiceBlockData(sliced) : null;
}

function readChoiceFence(
  lines: string[],
  openIndex: number,
  openLen: number,
): { data: ChoiceBlockData | null; end: number; failure?: ChoiceFailure; repaired?: boolean; body: string } | null {
  // 第一遍：CommonMark 严格闭合行优先，且无论正文是否合法都以它为界。
  let loose: { index: number; prefix: string } | null = null;
  for (let k = openIndex + 1; k < lines.length; k++) {
    if (closeReFor(openLen).test(lines[k])) {
      const body = lines.slice(openIndex + 1, k).join("\n");
      return { ...parseChoiceBodyEx(body), end: k, body };
    }
    // 顺手记下首个「行尾反引号」候选（粘行闭合 / 反引号数不足），等严格扫描落空后再验证。
    if (!loose) {
      const glued = GLUED_CLOSE_RE.exec(lines[k]);
      if (glued) loose = { index: k, prefix: glued[1] };
    }
  }
  // 第二遍：容错闭合——剥掉行尾反引号后正文仍能解析才采纳；解析失败但边界明确
  // （确实是模型写坏的围栏）仍以它为界返回，让调用方降级成代码块而不是当普通文本。
  if (loose) {
    const body = [...lines.slice(openIndex + 1, loose.index), loose.prefix].join("\n");
    return { ...parseChoiceBodyEx(body), end: loose.index, body };
  }
  // 第三遍：一个闭合都没有（模型忘了写）——把剩余文本整体当正文，剥掉可能的行尾反引号。
  const tail = lines.slice(openIndex + 1).join("\n").replace(/`{3,}\s*$/, "");
  const tailData = parseChoiceBodyBoundary(tail);
  return tailData ? { data: tailData, end: lines.length - 1, body: tail } : null;
}

/**
 * Split an assistant text block around ```choices fences. Fast path: blocks
 * without the marker come back as a single md segment with the ORIGINAL string
 * (identity preserved for memoization). A state machine tracks generic code
 * fences so a choices example QUOTED inside another fence is never activated.
 * Sloppily closed fences are tolerated by readChoiceFence; a fence with no usable
 * close is left as plain text unless its body parses as valid choices JSON.
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
    const info = open ? open[2].trim() : "";
    const exact = !!open && isChoicesInfoString(info);
    // 疑似档（choicesjson / choices_v2 这类写歪的标签）：升级门槛是正文严格解析通过。
    const like = !exact && !!open && CHOICES_LIKE_RE.test(info);
    if (!exact && !like) {
      if (open) fenceLen = open[1].length; // generic fence — skip until its close
      buf.push(line);
      i++;
      continue;
    }
    const read = readChoiceFence(lines, i, open[1].length);
    if (!read) {
      // Unterminated fence — treat the opening line as plain text.
      buf.push(line);
      i++;
      continue;
    }
    // 疑似档不开修复链：正文严格解析不过就维持原行为（当普通围栏，不给提示、不吞正文）。
    const likeData = like ? parseChoiceBodyBoundary(read.body) : null;
    if (like && !likeData) {
      fenceLen = open[1].length;
      buf.push(line);
      i++;
      continue;
    }
    flushMd();
    const data = like ? likeData : read.data;
    // info string 不是标准 choices → 带出去入诊断日志（面板本身照常渲染）。
    const rescued = info.toLowerCase() === "choices" ? undefined : info;
    segments.push(
      data
        ? {
            kind: "choice",
            data,
            ...(read.repaired && !like ? { repaired: true } : {}),
            ...(rescued ? { info: rescued } : {}),
            raw: read.body,
          }
        : { kind: "code", text: lines.slice(i, read.end + 1).join("\n"), ...(read.failure ? { reason: read.failure } : {}), raw: read.body },
    );
    i = read.end + 1;
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

// ---- 回传文本（契约） -------------------------------------------------------
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
/** 标题允许为空：跳过 + 补充的行是 `2. → 补充：…`（不给题目）。 */
const REPLY_LINE_RE = /^(\d+)\s*[.、)]\s*(.*?)\s*(?:→|->)\s*(.+)$/;
const OTHER_ANSWER_RE = /^(其它|Other)\s*[:：]\s*(\S.*)$/i;
const SKIP_ANSWER_RE = /^(已跳过|跳过|skipped)$/i;
const ALL_SKIP_RE = /^(（全部跳过）|\(all skipped\))$/i;
/** 答案尾部的中/英补充说明后缀（只认固定前缀，避免误伤选项自带的括号）。 */
const NOTE_SUFFIX_ZH_RE = /（补充[：:]\s*([\s\S]*?)）\s*$/;
const NOTE_SUFFIX_EN_RE = /\(note\s*[:：]\s*([\s\S]*?)\)\s*$/i;
/** 标题省略时的「仅补充」行：`2. → 补充：…`。 */
const NOTE_ONLY_RE = /^(补充|Note)\s*[:：]\s*([\s\S]*)$/i;

/** Normalize a title for comparison (whitespace collapse + trim). */
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

// ---- panel state derivation -------------------------------------------------

export type ChoicePanelState =
  | { kind: "pending" }
  | { kind: "answered"; answers: Record<number, ChoiceAnswer>; note?: string }
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
  const reply = parseChoiceReply(nextUser.text, data.questions);
  return reply
    ? { kind: "answered", answers: reply.answers, ...(reply.note ? { note: reply.note } : {}) }
    : { kind: "superseded" };
}
