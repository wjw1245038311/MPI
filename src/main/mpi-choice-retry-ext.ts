/**
 * choices 格式自动重试 bridge for pi（loaded via --extension，见 choice-retry-extension.ts）。
 *
 * 背景：弱模型常把 choices 围栏写坏——不是 JSON 转义，而是形态（开围栏写成 ```json、
 * 空 info 围栏后另起一行写 choices）或字段名（选项用 title 而非 label）。这类块在 MPI
 * 里会整块降级成代码块，用户拿不到可点的面板。实测（gpt-oss:20b-cloud，24 次）
 * 回喂失败原因后重试一次，9 个坏块救回 8 个。
 *
 * 做法：一轮彻底结束后（agent_settled 是 pi 唯一「不会再自动继续」的时点）
 *   1. 读本会话最后一条 assistant 文本，做**保守**判定：只有出现 choices 围栏标记
 *      却拿不出任何合法块时才算失败（宁漏判，不误判——否则会把正常纯文本提问
 *      强行改成面板）；
 *   2. 失败且本用户回合未重试过 → pi.sendMessage(display:false, triggerTurn:true)
 *      注入一条**用户不可见**的修正指令，让模型只重发围栏块。
 *
 * ⚠️ 本文件以 `?raw` 源码写进 userData 后被 pi 加载，**必须自包含**：
 *    不能 import 本仓模块（import 路径在 userData 下不存在）。
 *    判定逻辑与 src/renderer/src/lib/choice-block.ts 是**两份实现**，但**判据必须一致**：
 *    渲染端有 JSON 修复链（裸引号 / 缺括号 / 裸 label 对），这里的 parseChoicesBody
 *    拷贝了同一套修复链——否则「判非法 → 重试」与「仍能渲染 → 面板」会同时发生，
 *    一次输出就多出两个面板（2026-10-26 thinkbook16p 会话实证）。
 *    改这套修复链时必须同步两份副本；`npm run test:choiceretry` 除了行为语料，还会**逐字比对**这几段源码。
 *
 * 失败策略：全程 fail-open——判定抛错、注入失败，都只写 stderr 一行，绝不影响对话。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";

/** 只在显式关掉时停用（MPI_CHOICE_RETRY=0）。 */
const ENABLED = (process.env.MPI_CHOICE_RETRY || "1") !== "0";
/** 同一条 user 消息触发的重试只做一次；换一条 user 消息才允许再试。 */
const MAX_PER_TURN = 1;
/** 只记最近这几个 key，防止长会话无限增长。 */
const SEEN_LIMIT = 64;
/** 重试指令的 customType（主进程/渲染层按它 + display:false 过滤）。 */
const RETRY_TYPE = "mpi-choice-retry";

type Failure = { reason: string };

function log(msg: string): void {
  try {
    process.stderr.write(`[mpi-choice-retry] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

// ---- 设置同步：问答方式 = manual 时不重试 --------------------------------
// 「设置 → 对话设置 → 问答方式」存在 config.json 的 qaMode。manual 表示用户不要
// choices 面板，此时自动重试只会强行塞面板（与设置相反），必须停手。
// 文件很小，但每轮 settled 都读也不合适——按 mtime 缓存，设置一改立刻生效。
let qaCache: { mtimeMs: number; manual: boolean } | null = null;

/** 当前设置是不是「手动回答」；读不到配置就当成 inline（默认值）。 */
export function qaModeIsManual(configFile = process.env.MPI_CHOICE_CONFIG || ""): boolean {
  if (!configFile) return false;
  try {
    const st = statSync(configFile);
    if (qaCache && qaCache.mtimeMs === st.mtimeMs) return qaCache.manual;
    const cfg = JSON.parse(readFileSync(configFile, "utf8")) as { qaMode?: unknown };
    const manual = cfg?.qaMode === "manual";
    qaCache = { mtimeMs: st.mtimeMs, manual };
    return manual;
  } catch {
    // 配置还没落盘/正在写 → 保持上一次结论，别因为读失败把重试整个关掉。
    return qaCache?.manual ?? false;
  }
}

/** pi 的消息 content：字符串或 [text|image] 块数组。 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const b = part as any;
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** 会话条目过滤：只保留 message 条目并转成 {role, text, entryId}。 */
export function messagesOf(entries: unknown): { role: string; text: string; id: string }[] {
  if (!Array.isArray(entries)) return [];
  const out: { role: string; text: string; id: string }[] = [];
  for (const e of entries as any[]) {
    if (!e || e.type !== "message") continue;
    const m = e.message;
    if (!m || typeof m.role !== "string") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    // assistant 多段回复里可能含 tool_call 块，textOfContent 会自动跳过。
    out.push({ role: m.role, text: textOfContent(m.content), id: String(e.id ?? "") });
  }
  return out;
}

/** 开围栏：```choices / ```Choices / ```choices> 算；```choicesjson 也认（形态错的一种）。 */
const OPEN_RE = /^\s*(`{3,})\s*choices([^\s`]*)\s*$/i;
/** 形态错之「choices 单独一行，紧跟 ```json」或「空围栏下一行写 choices」。 */
const BARE_CHOICES_RE = /^\s*choices\s*[:：]?\s*$/i;
const ANY_FENCE_RE = /^\s*`{3,}\s*([a-zA-Z0-9_+-]*)\s*$/;

function closeReFor(len: number): RegExp {
  return new RegExp("^\\s*`{" + len + ",}\\s*$");
}

/** 结构校验：数组、每题有 title、至少两个选项、选项是字符串或 {label}。
 * 题数**没有上限**：渲染端超出 6 题是截断渲染 + 写明「已截断 N 题」（见
 * choice-block.ts 的 choiceDataFromJson）。这边判非法只会白重试一轮，
 * 而旧块已经画出来了 = 同一问题两个可点面板（2026-10-26 那个事故的同一个根）。 */
function shapeOk(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  for (const q of raw as any[]) {
    if (!q || typeof q !== "object") return false;
    if (typeof q.title !== "string" || !q.title.trim()) return false;
    if (!Array.isArray(q.options) || q.options.length < 2) return false;
    for (const o of q.options) {
      if (typeof o === "string") {
        if (!o.trim()) return false;
      } else if (o && typeof o === "object") {
        if (typeof (o as any).label !== "string" || !(o as any).label.trim()) return false;
      } else {
        return false;
      }
    }
  }
  return true;
}

// ---------------- JSON 修复链（与渲染端 choice-block.ts 同一套）----------------
// ⚠️ 本文件自包含（写进 userData 后 import 不到本仓模块），所以这里是**拷贝**。
// 为什么必须有：判定「要不要重试」的标准必须与「能不能渲染成面板」一致。
// 之前这里只做严格 JSON.parse，而渲染端有修复链 → 同一块被判非法（触发重试）
// 却照样渲染成面板 → 一次输出出现**两个面板**（2026-10-26 thinkbook16p 会话实证）。
// 改动此处必须同步 src/renderer/src/lib/choice-block.ts（test:choiceretry 会逐字比对两边源码）。

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
      else if (ch === '\"') inStr = false;
      continue;
    }
    if (ch === '\"') inStr = true;
    else if (ch === "[") stack.push("]");
    else if (ch === "{") stack.push("}");
    else if (ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return null;
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 字符串内裸露的英文双引号（未转义）→ 补转义。 */
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
      if (ch === '\"') {
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
    if (ch === '\"') inStr = true;
    out += ch;
  }
  return out;
}

/** 结尾括号补齐（模型把 JSON 写短了），顺便收尾未闭合的字符串。 */
function closeOpenBrackets(src: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '\"') inStr = false;
      continue;
    }
    if (ch === '\"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = src;
  if (inStr) out += '\"';
  while (stack.length) out += stack.pop();
  return out;
}

/** 结尾多余逗号（严格 JSON 不允许）。 */
function dropTrailingCommas(src: string): string {
  return src.replace(/,(\s*[}\]])/g, "$1");
}

/** 读一个 JSON 字符串键：返回 key 或 null（key 后须跟 `:`）。 */
function peekKey(src: string, i: number): string | null {
  if (src[i] !== '\"') return null;
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
    if (c === '\"') break;
    key += c;
  }
  if (j >= src.length) return null;
  let k = j + 1;
  while (k < src.length && /\s/.test(src[k])) k++;
  return src[k] === ":" ? key : null;
}

/** 裸 `"label":…` 对（options 里丢了 `{}` 包裹）→ 自动补 `{}`。 */
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
      if (ch === '\"') {
        inStr = false;
        prevSig = '\"';
      }
      continue;
    }
    if (ch === '\"') {
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

// ---------------- 以下五段与 src/renderer/src/lib/choice-block.ts 逐字一致 ----------------
// 2026-11-06 新增的四类「漏符号」修复：键名漏引号 / 无键成员 / 顶层漏 [] / 逐题兜底。
// ⚠️ 拷贝件：改这里必须同步渲染端，否则同一份输出会出现「这边能渲染成面板、那边判非法 → 白重试一轮」。

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
 * 右方括号这类尾巴剪掉）；本来就没写完的段落保留原样，交给 closeOpenBrackets 收尾。 */
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

/** 修复组合。顺序有讲究：**先补键名漏掉的引号**（不先把键名补正，后面所有引号的成对
 * 判定会跟着错位，裸引号修复会把好文本改坏）→ 转义串内裸引号 → 修无键成员 →
 * 给裸 `"label":` 对补 `{}` 包裹 → 补结尾括号 → 去尾逗号。（与渲染端同序）*/
function repairChain(src: string): string {
  return dropTrailingCommas(
    closeOpenBrackets(wrapBareLabelPairs(repairStrayMembers(escapeStrayQuotes(quoteBareKeys(src))))),
  );
}

/** ⑦ 逐题兜底：整块修不好时一段一段各自解析，只要有一段是能渲染的题就算合法。
 * （渲染端保留的就是这些段，两边判据必须一致，否则又是「白重试一轮」。） */
function salvageOk(body: string): boolean {
  return splitQuestionChunks(body).some((chunk) => {
    const variants = [chunk, repairChain(chunk), chunk.replace(/\}\s*$/, ""), repairChain(chunk.replace(/\}\s*$/, ""))];
    return variants.some((candidate) => {
      try {
        return shapeOk([JSON.parse(candidate)]);
      } catch {
        return false;
      }
    });
  });
}

/** 修复候选（改动越小越先试；全部由调用方做 JSON.parse + 结构校验）。 */
function repairCandidates(body: string): string[] {
  const trimmed = body.trim();
  const sliced = sliceFirstJson(trimmed);
  const out = [sliced ?? "", repairChain(trimmed)];
  if (sliced) out.push(repairChain(sliced));
  // ⑥ 顶层漏了数组包裹（只写了一个对象、或 `{` 前面那个 `[` 被吐掉）：
  //    只补开头的 `[`——结尾交给链上的 closeOpenBrackets 按实际层级补。
  if (trimmed && !trimmed.startsWith("[")) {
    out.push(`[${trimmed}]`, `[${trimmed}`, repairChain(`[${trimmed}`));
  }
  return out.filter((c) => c.length > 0);
}

/**
 * 解析围栏正文：严格 parse → 修复链。返回 repaired=true 说明是靠修复链救回来的。
 * `error` 只在两种路径都失败时给出（用于把位置回给模型，省一次重试）。
 */
export function parseChoicesBody(body: string): { ok: boolean; repaired?: boolean; error?: string } {
  let firstError: string | undefined;
  try {
    if (shapeOk(JSON.parse(body))) return { ok: true };
  } catch (e) {
    firstError = (e as Error)?.message || String(e);
  }
  for (const candidate of repairCandidates(body)) {
    try {
      if (shapeOk(JSON.parse(candidate))) return { ok: true, repaired: true };
    } catch {
      // 换下一个候选
    }
  }
  // 最后一道：逐题兜底（与渲染端同一判据）。
  if (salvageOk(body)) return { ok: true, repaired: true };
  return { ok: false, ...(firstError ? { error: firstError } : {}) };
}

/** 结构校验 + 修复链：能不能在 MPI 里渲染成面板（与渲染端同判据）。 */
export function isValidChoicesBody(body: string): boolean {
  return parseChoicesBody(body).ok;
}

/**
 * 从一段 assistant 文本里抽出所有 choices 围栏候选。
 * 返回 { fenced: 是否有 choices 围栏标记, validBlocks: 合法块数, broken: 是否出现了解析失败块, missingShape: 形态错 }
 */
export function inspectChoices(text: string): {
  fenced: boolean;
  validBlocks: number;
  broken: boolean;
  missingShape: boolean;
  /** 第一个坏块的严格 JSON 解析报错（含位置）—— 回给模型，省一次它自己找位置的重试。 */
  error?: string;
} {
  const lines = String(text || "").split(/\r?\n/);
  let fenced = false;
  let validBlocks = 0;
  let broken = false;
  let missingShape = false;
  let firstError: string | undefined;
  let openLen: number | null = null;
  let body: string[] = [];

  const finish = () => {
    if (openLen === null) return;
    // 与渲染层容错对齐：模型常把闭合反引号粘在 JSON 末尾，解析前先剥掉。
    const raw = body.join("\n").trim().replace(/`{3,}\s*$/, "").trim();
    const verdict = parseChoicesBody(raw);
    if (verdict.ok) validBlocks++;
    else {
      broken = true;
      if (!firstError && verdict.error) firstError = verdict.error;
    }
    openLen = null;
    body = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (openLen !== null) {
      if (closeReFor(openLen).test(line)) {
        finish();
        continue;
      }
      body.push(line);
      continue;
    }
    const open = OPEN_RE.exec(line);
    if (open) {
      fenced = true;
      openLen = open[1].length;
      body = [];
      continue;
    }
    // 形态错：一行只有 choices，后面紧跟 ```json（模型把语言标签写到了围栏上）
    if (BARE_CHOICES_RE.test(line)) {
      const next = (lines[i + 1] || "").trim();
      const fence = ANY_FENCE_RE.exec(next);
      if (fence) missingShape = true;
      // 形态错：空围栏 + 下一行 choices（choices 落在围栏外面）
    }
    const fence = ANY_FENCE_RE.exec(line);
    if (fence && !fence[1]) {
      const next = (lines[i + 1] || "").trim();
      if (BARE_CHOICES_RE.test(next)) missingShape = true;
    }
  }
  // 开到文末没闭合：同样当坏块（MPI 只在正文能严格解析时才接受粘行闭合）
  if (openLen !== null) finish();
  return { fenced, validBlocks, broken, missingShape, ...(firstError ? { error: firstError } : {}) };
}

/**
 * 一轮回答是否需要重试。保守：出现 choices 标记、且一个合法块都没有。
 * - 有合法块：不重试（哪怕另有坏块——重试会导致面板重复出现）
 * - 没有任何 choices 痕迹：不重试（正常纯文本提问）
 */
export function detectFailure(text: string): Failure | null {
  const info = inspectChoices(text);
  if (!info.fenced && !info.missingShape) return null;
  if (info.validBlocks > 0) return null;
  if (info.broken) {
    // 能进到这里说明没有合法块（修复链也救不回来），坏块的具体原因对重试提示有区分价值：
    // 先按「正文是否以 [ 开头」粗分，再把严格解析的报错位置一并回给模型。
    const looksJsonArray = /\[\s*\{/.test(String(text || ""));
    const where = info.error ? `；严格 JSON 在${positionOf(info.error)}报错：${trimError(info.error)}` : "";
    return {
      reason: (looksJsonArray
        ? "围栏正文不是合法 JSON 或选项字段不对（常见：中文串里裸英文双引号；选项用 title 而不是 label）"
        : "围栏正文不是合法 JSON 数组") + where,
    };
  }
  return { reason: "没有识别到合法的 choices 围栏（开围栏必须单独一行 ```choices，不能写成 ```json，也不能把 choices 写在围栏外面）" };
}

/** 从 V8 / JSC 的 JSON 报错里抽「位置」描述，没找到就空串。 */
function positionOf(err: string): string {
  const m = /(at position \d+|line \d+ column \d+|unexpected token)/i.exec(err);
  return m ? ` ${m[1]}` : "";
}

/** 报错文本限长：提示词里只要位置和一句原因，长堆栈没意义。 */
function trimError(err: string): string {
  return err.replace(/\s+/g, " ").slice(0, 160);
}

/** 修正指令：只给「为什么不过 + 要什么形态」，与实测 89% 修好的提示词一致。 */
export function retryHint(reason: string): string {
  return [
    "【格式修正 · 非用户消息】你上一条回复里的 choices 块没有通过格式校验，MPI 无法渲染成面板。",
    "原因：" + reason,
    "请只重新输出这一个 choices 块，不要重复正文、不要解释、不要道歉：",
    "1) 第一行单独写 ```choices（三个反引号 + 空格省略 + 单词 choices，独占一行）；",
    '2) 第二行开始是纯 JSON 数组，形如 [{"title":"问题","options":[{"label":"选项A","detail":"一句话"},"选项B"]}]；',
    "3) 选项对象必须用 label 字段（不能写 title / text / name）；",
    "4) 最后一行单独写 ```。",
  ].join("\n");
}

/** 取最后一条 assistant 文本（重试是否已在本次 user 回合发生过，由调用方判断）。 */
export function lastAssistantText(entries: unknown): string {
  const msgs = messagesOf(entries);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") return msgs[i].text;
  }
  return "";
}

/** 本回合的 key：最后一条 user 消息的条目 id（没有则用时间戳兜底）。 */
export function turnKey(entries: unknown): string {
  const msgs = messagesOf(entries);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i].id || `i${i}`;
  }
  return "";
}

/** 已经从上下文里搞掉的重试指令 id（避免每轮重复 appendContextEdit）。 */
const cleanedRetryIds = new Set<string>();

/**
 * 重试指令要参与「重试那一轮」的上下文，但之后不该常驻（约 160 token/条）。
 * 一轮结束后用 pi 的 appendContextEdit(id, null) 把它从模型可见上下文里摘掉：
 * 会话文件里仍留着该条目（可审计），只是不再随每轮请求发送。
 *
 * 判定用「其后是否已经出现过 assistant 消息」：有 = 这一轮已经用过了。
 */
export function clearUsedRetryInstructions(sessionManager: any): number {
  let entries: any[];
  try {
    entries = sessionManager?.getEntries?.() ?? [];
  } catch {
    return 0;
  }
  if (!Array.isArray(entries)) return 0;

  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "message" && e.message?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) return 0; // 指令刚注入、重试轮还没跑 → 保留

  let n = 0;
  for (let i = 0; i < lastAssistant; i++) {
    const e = entries[i];
    if (e?.type !== "custom_message" || e.customType !== RETRY_TYPE) continue;
    const id = typeof e.id === "string" ? e.id : "";
    if (!id || cleanedRetryIds.has(id)) continue;
    try {
      sessionManager.appendContextEdit(id, null);
      cleanedRetryIds.add(id);
      n++;
    } catch {
      // 不在活动分支 / 旧会话不允许编辑 → 忽略，不影响本轮。
    }
  }
  return n;
}

export default function mpiChoiceRetry(pi: ExtensionAPI): void {
  if (!ENABLED) {
    log("MPI_CHOICE_RETRY=0 —— 自动重试已停用");
    return;
  }

  /** 已重试过的 turnKey（Map 当 LRU 用：满了就删最早的一个）。 */
  const retried = new Map<string, number>();

  pi.on("agent_settled", (_event: any, ctx: any) => {
    try {
      const sm = ctx?.sessionManager;
      // 1) 先把上一轮用过的修正指令从上下文搞掉（不删文件，只影响模型可见内容）。
      const dropped = clearUsedRetryInstructions(sm);
      if (dropped) log(`清理已用过的修正指令 ${dropped} 条（不再占上下文）`);

      // 2) 设置 → 问答方式 = 手动回答：用户不要面板，绝不自动补。
      if (qaModeIsManual()) return;

      // 3) 判定本轮回答
      const entries = sm?.getEntries?.();
      const text = lastAssistantText(entries);
      if (!text) return;
      const failure = detectFailure(text);
      if (!failure) return;

      const key = turnKey(entries) || "anon";
      const count = retried.get(key) || 0;
      if (count >= MAX_PER_TURN) {
        log(`本回合已重试过 ${count} 次，跳过（key=${key.slice(0, 8)}）`);
        return;
      }
      retried.set(key, count + 1);
      if (retried.size > SEEN_LIMIT) retried.delete(retried.keys().next().value as string);

      // display:false → pi TUI 不渲染；MPI 侧也按 display 过滤（见 ipc.ts onEvent）。
      // triggerTurn:true → 立刻起一轮，让模型只重发围栏块。
      pi.sendMessage(
        {
          customType: RETRY_TYPE,
          content: retryHint(failure.reason),
          display: false,
        },
        { triggerTurn: true },
      );
      log(`注入重试指令（key=${key.slice(0, 8)}）：${failure.reason.slice(0, 60)}`);
    } catch (e) {
      log(`重试判定失败（已忽略）：${(e as Error)?.message || String(e)}`);
    }
  });
}
