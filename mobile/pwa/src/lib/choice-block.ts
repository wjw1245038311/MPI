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
 * JSON 修复链（与桌面端逐字对齐）：全部只在严格解析失败后启用，结果必须能过
 * choiceDataFromJson 的结构校验才采纳。七类坏法（前六类补符号，最后一类只丢真读不出的一题）：
 *   ① 串里未转义的英文双引号；② 结尾少括号；③ options 里丢了 `{}` 的裸 `"label":…` 对；
 *   ④ 键名漏了开头的 `"`；⑤ 对象里冒出无键成员；⑥ 顶层漏了 `[]`；⑦ 逐题兜底。
 * 依据 2026-10 / 2026-11-06 两次历史会话盘点（498 个围栏 / 5 个失败 → 1101 个 / 5 个）。
 * ⚠️ 改动必须同步 src/renderer/src/lib/choice-block.ts 与 src/main/mpi-choice-retry-ext.ts，
 *    `npm run test:choiceretry` 的「多份实现对账」会直接比对这几段的源码。
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
  /** repaired：这份数据是靠修复链救回来的（对齐桌面端，便于以后统计）。
   *  dropped：同一消息里前面还有 N 个重复块被折叠（只渲染最后一块，与桌面端同一规则）。 */
  | { kind: "choice"; data: ChoiceBlockData; repaired?: boolean; dropped?: number };

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
      // 正文空白的 choices 围栏（如 ```choices> 后面没内容）：静默丢弃，
      // 不出空代码块 / 不给「格式不合法」警告（与桌面端同一规则，2026-10-27 实证）。
      if (!seg.text.trim()) continue;
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

  // 同一条回复里的多个块：只折叠**内容等价**的（模型重写），内容不同的全部保留
  // ——一条回复里问多组不同的问题是合法的，不能静默丢题（与桌面端 choiceSignature 同规则）。
  const choiceAt: number[] = [];
  out.forEach((seg, k) => {
    if (seg.kind === "choice") choiceAt.push(k);
  });
  if (choiceAt.length > 1) {
    const lastBySign = new Map<string, number>();
    const countBySign = new Map<string, number>();
    for (const k of choiceAt) {
      const seg = out[k];
      if (seg.kind !== "choice") continue;
      const sign = choiceSignature(seg.data);
      lastBySign.set(sign, k);
      countBySign.set(sign, (countBySign.get(sign) ?? 0) + 1);
    }
    const collapsed = new Set<number>();
    for (const k of choiceAt) {
      const seg = out[k];
      if (seg.kind !== "choice") continue;
      const sign = choiceSignature(seg.data);
      if (lastBySign.get(sign) !== k) {
        collapsed.add(k);
        continue;
      }
      const dupes = (countBySign.get(sign) ?? 1) - 1;
      if (dupes > 0) out[k] = { ...seg, dropped: dupes };
    }
    if (collapsed.size) return out.filter((_, k) => !collapsed.has(k));
  }
  return out;
}

/** 判重签名：题目 + 每题选项 label（忽略 detail 与空白差异），与桌面端同一规则。 */
export function choiceSignature(data: ChoiceBlockData): string {
  return data.questions
    .map((q) => `${q.title.replace(/\s+/g, "")}|${q.options.map((o) => o.label.replace(/\s+/g, "")).join(",")}`)
    .join(";");
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
