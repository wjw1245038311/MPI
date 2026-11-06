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
 *   ① 精确档 `isChoicesInfoString`：**开头必须是 choices 这个词**（后面不紧跟字母/数字），
 *      再往后带什么噪声都忍（`choices>` / `choices:` / `choices json` / 正文直接写在同一行）
 *      ——按标准 choices 围栏处理；`choicesjson` 这类「另一个标签」不算。
 *      （放宽于 2026-11-06：旧规则只允许非字母数字尾缀，`choices json` 不画面板。）
 *   ② 疑似档（以 choices 开头但紧跟字母，如 `choicesjson`）：只有正文**严格**
 *      解析通过才升级为面板（不开修复链），否则维持原行为当普通围栏。
 * 两档里 info string 不等于标准 `choices` 的，段上带 `info` 字段，由 Chat.tsx
 * 写一行诊断日志（choice-fence-info），便于以后看哪些笔误形态真的出现过。
 *
 * 围栏本身还宽忍三种写法（同上，全部以「含 choices 字样」为前提，2026-11-06）：
 * 闭合用 `~~~`、开围栏写在 markdown 列表项里（`- ```choices）、正文与开围栏同一行。
 * **不含 choices 字样的（```json）依旧不画面板**——这是「文档里的 JSON 示例不会被误当
 * 选择题」的保险；那种写法由主进程的重试判定回喂模型重写（且仅限位于回答末尾时，
 * 见 mpi-choice-retry-ext.ts 的 looksLikeMislabelledJson）。
 *
 * 再往里一层是「JSON 修复链」（见 repairCandidates）：模型偶尔把正文写成
 * 语法非法的 JSON（中文串里夹未转义的英文双引号、结尾少括号、options 里丢
 * `{}` 包裹），严格 parse 必挂。修复链只在严格解析失败后启用，且修复结果必须
 * 再通过结构校验才采纳——修不出来就维持降级（并给出精确原因 + 原始正文入
 * 诊断日志），绝不把普通正文吞成面板。
 *
 * 2026-11-06 又补了四类「漏符号」形态（键名漏引号 / 对象里冒出无键成员 /
 * 顶层漏 `[]` / 一题写坏拖全块）。判断依据仍然是：**文本内容总是对的，坏的
 * 只是标点**，所以只补标点、不改内容；补不出合法结构的照旧降级。
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
      info?: string;
      /** 同一消息里与它**内容等价**的重复块被折叠的数量（签名相同才折叠，见
       *  choiceSignature）。>0 时渲染层记一行诊断。 */
      dropped?: number }
  /** A ```choices fence whose body is not valid JSON — rendered as a plain code block
   * (Chat.tsx 会在其下方给一行「未渲染成面板」提示；reason/raw 供文案与诊断日志). */
  | { kind: "code"; text: string; reason?: ChoiceFailure; raw?: string };

/** Opening backtick fence: capture the run length + info string. */
const FENCE_OPEN_RE = /^\s*(`{3,})(.*)$/;
/** choices 专用开围栏：允许前面是 markdown 列表符号（`- ` / `1. `）。
 * 模型把提问写在列表项里时会出现（2026-11-06 另一台设备实测：整块被当普通代码块渲染，
 * 连「格式不合法」提示都没有）。只用在 choices 路径，普通代码块仍走 FENCE_OPEN_RE。 */
const CHOICES_LIST_OPEN_RE = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+(`{3,}|~{3,})(.*)$/;
/** Closing fence for a fence opened with `len` backticks (CommonMark: the
 * closer must be at least as long and carry no info string). */
const closeReFor = (len: number) => new RegExp("^\\s*`{" + len + ",}\\s*$");
/** choices 围栏的闭合行：比 CommonMark 多忍一种——**波浪号闭合**（模型混用 ``` 与 ~~~ 时，
 * 严格判定会把后面的正文全吃进代码块）。同样只用在 choices 路径。 */
const choiceCloseReFor = (len: number) => new RegExp("^\\s*[`~]{" + len + ",}\\s*$");
/** 正文末尾挂着的闭合围栏（反引号或波浪号），「忘了写闭合」那道兜底先剥掉它。 */
const TRAILING_FENCE_RE = /(?:`{3,}|~{3,})\s*$/;
/** 行尾挂着 ≥3 个反引号/浪加号的行（模型把闭合围栏粘在正文末尾时）；捕获之前的正文。 */
const GLUED_CLOSE_RE = /^(.*?)(?:`{3,}|~{3,})\s*$/;
/** 精确档 info string：**开头必须是 choices 这个词**（后面不能紧跟字母/数字），再往后带什么
 * 噪声都忍：`choices>` / `choices:` / `choices json` / 以及正文直接写在同一行的 `choices [{…}]`。
 * 为什么放宽（2026-11-06）：旧规则只允许非字母数字尾缀，`choices json` 会掉到严格档不画面板；
 * 而放宽的边界很窄——**不含 choices 字样的一律进不来**，这就是「文档里引用的 ```json 示例
 * 不会被误当面板」的保险。`choicesjson` 这种「另一个标签」仍走疑似档。 */
const CHOICES_INFO_RE = /^choices(?![a-z0-9])/i;
/** 疑似档：以 choices 开头的其它标签（模型把语言标签写歪）。 */
const CHOICES_LIKE_RE = /^choices/i;

/** info string 是否应视为 choices 围栏（`choices` / `choices>` / `Choices` / `choices json` 都算）。 */
export function isChoicesInfoString(info: string | undefined): boolean {
  return CHOICES_INFO_RE.test((info ?? "").trim());
}

/** 开围栏同一行后面挂的正文（形如 ` ```choices [{"title":…}] `）：只有以 `[` 或 `{` 开头才算，
 * 否则它是第二个语言标签（`choices json` 里的 json），归 info 管。 */
function inlineBodyHead(info: string): string {
  const m = /^\S+[ \t]+([[{].*)$/.exec((info ?? "").trim());
  return m ? m[1].trim() : "";
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
 * 依据 2026-10 对全部历史会话的盘点（498 个 choices 围栏 / 5 个失败）实践出来的前三类：
 *   ① 字符串里夹未转义的英文双引号（中文串里常发生）→ escapeStrayQuotes
 *   ② JSON 结尾被写短（少了 `}`/`]`）→ completeBrackets
 *   ③ options 里丢了 `{}` 包裹的裸 `"label":…` 对 → wrapBareLabelPairs
 * 再往后两批。2026-11-06 下午先按 1101 个围栏的盘点补了四类（都是「漏符号」）：
 *   ④ 键名漏了开头的 `"`（`,detail":"说明"}`、`{label:"甲"}`）→ quoteBareKeys
 *   ⑤ 对象里冒出无键成员（`],{` ——数组提前收尾 / 真的多一个）→ repairStrayMembers
 *   ⑥ 顶层漏了 `[]`（只写一个对象，或 `[` 被吐掉）→ repairCandidates 里的包裹候选
 *   ⑦ 一题写坏拖全块 → questionStarts + splitQuestionChunks + salvageQuestions（逐题兜底）
 * 傍晚又拿另一台设备的**真实坏块原文**（用户提供的会话导出）复现出两类，那才是他遇到的：
 *   ⑧ **中间**漏一层闭合括号：`"options":["甲","乙"}` ——旧版只往末尾追加括号，
 *      这种怎么补都修不好 → completeBrackets 改成按层补，并丢弃多余的闭符号；
 *   ⑨ 整个围栏**没有闭合**（模型写到正文里就停了，stop_reason 仍是 stop 不是截断）：
 *      这一档原先只允许严格解析，于是「没闭合 + 缺个括号」谁都不管——既不画面板也
 *      **不显示降级提示**（用户看到的就是一个普通代码卡片）。现在正文以 `[` / `{` 开头时
 *      允许走修复链，且只在真修好了才接管（修不好原样留着，绝不把下文吸进代码块）。
 * 这九类之外（真正乱七八糟的）修不出来，维持原行为。
 *
 * ⚠️ 下面这段修复链有**两份拷贝**：src/main/mpi-choice-retry-ext.ts（判要不要重试）
 * 与 mobile/pwa/src/lib/choice-block.ts（网页版客户端）。`npm run test:choiceretry`
 * 既跑「能渲染 ⇔ 不重试」的行为对账，也逐字比对这几段源码——只改一边会直接报错。
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

/** 能补的括号上限：再多就不是「漏了一两个符号」，而是整段乱写了，直接不修。 */
const MAX_REPAIR_BRACKETS = 24;

/** 补漏掉的闭合括号——**中间和末尾都补**。
 * 旧版只往末尾追加（治「写到一半断了」），但 2026-11-06 用真实会话实测到另一种写法：
 * `"options":["甲","乙"}` ——少的是**中间那一层的 `]`**，末尾补多少个括号也修不好。
 * 现在扫描时维护「应该出现哪个闭符号」的栈：遇到类型不符的闭符号，先把缺的补上再收下它；
 * 栈里根本没这一层（模型多敲的）就丢掉；走完还剩没关的，按内→外补全。
 * 补错也不会误渲染：调用方还要过 JSON.parse + 结构校验才采纳。
 * ⚠️ 同名同义的两份拷贝：主进程重试扩展与 PWA 客户端（test:choiceretry 逐字比对）。 */
function completeBrackets(src: string): string {
  let out = "";
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let inserted = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "{") {
      stack.push("}");
      out += ch;
      continue;
    }
    if (ch === "[") {
      stack.push("]");
      out += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      // 正常情形：类型对得上，弹栈收下。
      if (stack[stack.length - 1] === ch) {
        stack.pop();
        out += ch;
        continue;
      }
      // 栈里根本没这一层 → 模型多敲了一个，丢掉（末尾多出的 `]` 就是这么来的）。
      if (!stack.includes(ch)) continue;
      // 有这一层，但它上面还压着没关的 → 那一层忘了闭合：先补上再收下。
      while (stack.length && stack[stack.length - 1] !== ch) {
        out += stack.pop() ?? "";
        if (++inserted > MAX_REPAIR_BRACKETS) return src;
      }
      stack.pop();
      out += ch;
      continue;
    }
    out += ch;
  }
  if (inStr) out += '"';
  if (stack.length > MAX_REPAIR_BRACKETS) return src;
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

/** 跳过一个以 src[start]（`[` 或 `{`）开头的配平片段，返回其后的下标；不配平返回 -1。 */
function skipBalanced(src: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") stack.push(ch === "[" ? "]" : "}");
    else if (ch === "]" || ch === "}") {
      if (stack.pop() !== (ch === "]" ? "]" : "}")) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/** 裸键名的形状（漏了引号之后剩下的就是它）。 */
const BARE_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/** ④ 键名漏了开头的英文双引号 → 补引号。
 * 实测两种写法：`,detail":"说明"}`（只漏开头，原文里那个引号是键名的收尾）和
 * `{label:"甲"}`（两头都漏）。判定只看结构：不在字符串里、前一个有效字符是
 * `{` 或 `,`、裸标识符后面（可跳空白）确实跟着 `:`。值位置一概不碰——宁可漏修，
 * 也不要把中文正文改坏。 */
function quoteBareKeys(src: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  let esc = false;
  let prevSig = "";
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      prevSig = '"';
      i++;
      continue;
    }
    if ((prevSig === "{" || prevSig === ",") && /[A-Za-z_$]/.test(ch)) {
      const key = BARE_KEY_RE.exec(src.slice(i))?.[0] ?? "";
      if (key) {
        let j = i + key.length;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === ":") {
          // `label:` → `"label":`
          out += `"${key}"`;
          i += key.length;
          prevSig = '"';
          continue;
        }
        let k = j + 1;
        if (src[j] === '"') {
          while (k < src.length && /\s/.test(src[k])) k++;
          if (src[k] === ":") {
            // `detail":` → `"detail":`
            out += `"${src.slice(i, j + 1)}`;
            i = j + 1;
            prevSig = '"';
            continue;
          }
        }
      }
    }
    out += ch;
    prevSig = ch;
    i++;
  }
  return out;
}

/** ⑤ 对象里冒出「没有键名」的成员——JSON 的键必须是字符串，这个位置出现 `[`/`{`
 * 只能是漏了键。实测两种坏法，分开处理：
 *   A. `"options":["甲","乙"],{"label":"丙"}]}` ——数组刚收尾就被逗号接上一个对象：
 *      模型其实是想把它当数组元素，多吃了一个 `]`。吃掉那个过早的 `]` 把数组
 *      重新打开（它本来就没写完，后面的 `]` 正好拿来收尾），**选项一个不丢**；
 *   B. 其它形态（真的多了一个成员）→ 整段丢掉，剩下的照常渲染；丢完留下的空逗号
 *      交给尾逗号修复。
 * 动手条件很窄：当前容器是**对象**、位置该放键名（前一个有效字符是 `{` 或 `,`）。 */
function repairStrayMembers(src: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let prevSig = "";
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      prevSig = '"';
      i++;
      continue;
    }
    if ((ch === "[" || ch === "{") && stack[stack.length - 1] === "}" && (prevSig === "{" || prevSig === ",")) {
      // A. 紧跟在 `],` 后面：数组被提前关掉了，这个对象本该是它的元素。
      if (prevSig === "," && /]\s*,\s*$/.test(out)) {
        out = out.replace(/]\s*(,\s*)$/, "$1");
        stack.push("]"); // 那个 `]` 被吃掉了，容器还在里层
        continue; // 不推进 i：当前括号按正常入栈处理（此时顶层已是数组）
      }
      // B. 真的多了一个成员：整段跳过（带它前面的逗号）。
      const end = skipBalanced(src, i);
      if (end > i) {
        if (prevSig === ",") out = out.replace(/,\s*$/, "");
        i = end;
        continue;
      }
    }
    if (ch === "[" || ch === "{") stack.push(ch === "[" ? "]" : "}");
    else if (ch === "]" || ch === "}") stack.pop();
    out += ch;
    prevSig = ch;
    i++;
  }
  return out;
}

/** 修复组合。顺序有讲究：**先补键名漏掉的引号**（不先把键名补正，后面所有引号的成对
 *  判定会跟着错位，裸引号修复会把好文本改坏）→ 转义串内裸引号 → 修无键成员 → 给裸 `"label":` 对补 `{}` 包裹 → 补结尾括号 → 去尾逗号。 */
function repairChain(src: string): string {
  return dropTrailingCommas(
    completeBrackets(wrapBareLabelPairs(repairStrayMembers(escapeStrayQuotes(quoteBareKeys(src))))),
  );
}

/** 修复候选（改动越小越先试；全部由调用方做 JSON.parse + 结构校验）。 */
function repairCandidates(body: string): string[] {
  const trimmed = body.trim();
  const sliced = sliceFirstJson(trimmed);
  const out = [sliced ?? "", repairChain(trimmed)];
  if (sliced) out.push(repairChain(sliced));
  // ⑥ 顶层漏了数组包裹：只写了一个对象，或 `{` 前面那个 `[` 被吐掉。
  //    只补开头的 `[`——结尾交给链上的 completeBrackets 按实际层级补，
  //    这样「既漏外层又写到一半就断」也能一起修好。已以 `[` 开头的不试。
  if (trimmed && !trimmed.startsWith("[")) {
    out.push(`[${trimmed}]`, `[${trimmed}`, repairChain(`[${trimmed}`));
  }
  return out.filter((c) => c.length > 0);
}

/** ⑦ 找出「一道题」的起点：「{」后面（可跳空白）就是 title 键。
 * 用 title 当锚点而不是按括号配平切项——模型漏一个引号就会让后面所有引号成对
 * 错位，跟着的括号计数一起乱（2026-11-06 实测：三项里坏一项，旧切法一项都取不出）。
 * 而结构校验本来也只认带 title 的对象，锚点与「能渲染的项」正好是同一个条件。 */
function questionStarts(src: string): number[] {
  const out: number[] = [];
  const re = /\{\s*"?\s*title\s*"?\s*:/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null && out.length < 12) {
    out.push(m.index);
    if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
  }
  return out;
}

/** ⑦ 按锚点切成「一题一段」。段尾剪到最后一个右花括号（把逗号、外层数组的
 * 右方括号这类尾巴剪掉）；本来就没写完的段落保留原样，交给 completeBrackets 收尾。 */
function splitQuestionChunks(src: string): string[] {
  const starts = questionStarts(src);
  // 少于两段就没有「逐题兜底」的必要（整块的候选已经把它试过一遍了）。
  if (starts.length < 2) return [];
  const out: string[] = [];
  for (let k = 0; k < starts.length; k++) {
    const to = k + 1 < starts.length ? starts[k + 1] : src.length;
    let piece = src.slice(starts[k], to);
    const close = piece.lastIndexOf("}");
    if (close > 0) piece = piece.slice(0, close + 1);
    piece = piece.trim();
    if (piece) out.push(piece);
  }
  return out;
}

/** ⑦ 逐题兜底：整块修不好时一段一段各自解析，只保留救得回来的题。
 * 一题写坏不该让其它题一起降级成代码块（2026-11-06 实证：一份正文里只有一处
 * 漏了引号，旧实现整块不渲染）。解析不出的段留个空题占位，由结构校验计成
 * 「被截断的题」（面板下方有说明），绝不悄悄消失。 */
function salvageQuestions(body: string): ChoiceBlockData | null {
  const chunks = splitQuestionChunks(body);
  if (!chunks.length) return null;
  const kept: unknown[] = [];
  for (const chunk of chunks) {
    let parsed: unknown;
    let done = false;
    // 剪过尾巴与原样两种都试：截到的右花括号可能属于内层对象，不是这一题的收尾。
    for (const candidate of [chunk, repairChain(chunk), chunk.replace(/\}\s*$/, ""), repairChain(chunk.replace(/\}\s*$/, ""))]) {
      try {
        parsed = JSON.parse(candidate);
        done = true;
        break;
      } catch {
        // 换下一个候选
      }
    }
    kept.push(done ? parsed : { title: "", options: [] });
  }
  return choiceDataFromJson(kept);
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
  // 最后一道：逐题兜底（一块里有好几题时，只丢真读不出来的那题）。
  const salvaged = salvageQuestions(body);
  if (salvaged) return { data: salvaged, repaired: true };
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
  /** 与开围栏写在同一行的正文（作为首行拼回去）。 */
  head = "",
): { data: ChoiceBlockData | null; end: number; failure?: ChoiceFailure; repaired?: boolean; body: string } | null {
  const prefix = head ? [head] : [];
  // 第一遍：严格闭合行优先（choices 比 CommonMark 多忍一种波浪号闭合），
  // 且无论正文是否合法都以它为界。
  let loose: { index: number; prefix: string } | null = null;
  for (let k = openIndex + 1; k < lines.length; k++) {
    if (choiceCloseReFor(openLen).test(lines[k])) {
      const body = [...prefix, ...lines.slice(openIndex + 1, k)].join("\n");
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
    const body = [...prefix, ...lines.slice(openIndex + 1, loose.index), loose.prefix].join("\n");
    return { ...parseChoiceBodyEx(body), end: loose.index, body };
  }
  // 第三遍：一个闭合都没有（模型忘了写）——把剩余文本整体当正文，剥掉可能的行尾反引号。
  const tail = [...prefix, ...lines.slice(openIndex + 1)].join("\n").replace(TRAILING_FENCE_RE, "");
  // 门槛：正文**从 [ 或 { 开头**才走修复链——这种形状不可能是散文，补括号不会误吞正文；
  // 其它正文仍只允许严格解析。旧规则一律严格，于是「没有闭合围栏 + 缺个括号」谁都不管。
  if (/^\s*[[{]/.test(tail)) {
    // **只在真的修好了时才接管**：这种写法根本没有任何闭合边界，
    // 修不好就把后面的文字原样留着（不能把整段下文吸进代码块）。
    const rep = parseChoiceBodyEx(tail);
    return rep.data ? { ...rep, end: lines.length - 1, body: tail } : null;
  }
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
 *
 * `stats` 可选：调用方传一个对象就能拿到「空块被丢弃了几个」这类计数（诊断用）。
 */
export function splitChoiceSegments(text: string, stats?: ChoiceSplitStats): ChoiceSegment[] {
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
    // choices 专用：上面没匹配时再试「列表项里写围栏」这种形态（普通代码块不走这条路）。
    const listOpen = open ? null : CHOICES_LIST_OPEN_RE.exec(line);
    const fence = open ?? listOpen;
    const info = fence ? fence[2].trim() : "";
    const exact = !!fence && isChoicesInfoString(info);
    // 疑似档（choicesjson / choices_v2 这类写歪的标签）：升级门槛是正文严格解析通过。
    const like = !exact && !!fence && CHOICES_LIKE_RE.test(info);
    if (!exact && !like) {
      if (open) fenceLen = open[1].length; // generic fence — skip until its close
      buf.push(line);
      i++;
      continue;
    }
    // 与开围栏写在同一行的正文（` ```choices [{…}] `）当首行传进去；
    // `choices json` 里的第二个标签不是正文（inlineBodyHead 只认以 [ / { 开头的）。
    const inlineHead = inlineBodyHead(info);
    const read = readChoiceFence(lines, i, fence![1].length, inlineHead);
    if (!read) {
      // Unterminated fence — treat the opening line as plain text.
      buf.push(line);
      i++;
      continue;
    }
    // 疑似档不开修复链：正文严格解析不过就维持原行为（当普通围栏，不给提示、不吞正文）。
    const likeData = like ? parseChoiceBodyBoundary(read.body) : null;
    if (like && !likeData) {
      if (open) fenceLen = open[1].length;
      buf.push(line);
      i++;
      continue;
    }
    // 正文空白的 choices 围栏（```choices> 后面没内容）：静默丢弃。
    // 2026-10-27 实证：空残块曾被渲染成空代码块 + 「格式不合法」提示，纯噪音。
    if (!read.body.trim()) {
      if (stats) stats.emptyChoices = (stats.emptyChoices ?? 0) + 1;
      i = read.end + 1;
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

  // 同一条回复里的多个块：只折叠**内容等价**的（模型先写草稿再重写），内容不同的
  // 全部保留——一条回复里问多组不同的问题是合法的，不能静默丢题。
  // 2026-10-27 实证（正反两面）：模型在同一次回复里先写草稿块再重写，两个块都被渲染；
  // 但同一批里也有 3 个**不同**问题 + 1 个空残块的消息，旧「只留最后一个」把两道题丢了。
  // 折叠判定用 choiceSignature（题目 + 选项 label，忽略 detail 与空白）。
  const choiceAt: number[] = [];
  segments.forEach((seg, k) => {
    if (seg.kind === "choice") choiceAt.push(k);
  });
  if (choiceAt.length > 1) {
    const lastBySign = new Map<string, number>();
    const countBySign = new Map<string, number>();
    for (const k of choiceAt) {
      const seg = segments[k];
      if (seg.kind !== "choice") continue;
      const sign = choiceSignature(seg.data);
      lastBySign.set(sign, k);
      countBySign.set(sign, (countBySign.get(sign) ?? 0) + 1);
    }
    const drop = new Set<number>();
    for (const k of choiceAt) {
      const seg = segments[k];
      if (seg.kind !== "choice") continue;
      const sign = choiceSignature(seg.data);
      if (lastBySign.get(sign) !== k) {
        drop.add(k);
        continue;
      }
      const dupes = (countBySign.get(sign) ?? 1) - 1;
      if (dupes > 0) segments[k] = { ...seg, dropped: dupes };
    }
    for (let k = segments.length - 1; k >= 0; k--) if (drop.has(k)) segments.splice(k, 1);
  }

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

/** splitChoiceSegments 的附带统计（诊断用）。 */
export interface ChoiceSplitStats {
  /** 正文为空白、被静默丢弃的 choices 围栏数。 */
  emptyChoices?: number;
}

/** 判重签名：题目 + 每题选项 label（忽略 detail 与空白差异）。
 *  两个块签名相同 = 内容等价（模型重写），只渲染最后一个；不同则全部保留。 */
export function choiceSignature(data: ChoiceBlockData): string {
  return data.questions
    .map((q) => `${q.title.replace(/\s+/g, "")}|${q.options.map((o) => o.label.replace(/\s+/g, "")).join(",")}`)
    .join(";");
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
