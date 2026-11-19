/**
 * edit 失败恢复指引 bridge（edit 工具匹配失败时附上「最接近的原文」）。
 *
 * 为什么需要
 * ----------
 * pi 内置 edit 在三处会直接抛 "Could not find edits[k] ..."：oldText 在文件里找不到。
 * 这条错误只说「没找到」，不告诉模型文件里实际写的是什么，于是模型只能：
 * ①原样重发同一个请求（实测 2 次都失败）②凭记忆改一处字再试。
 * 2026-11-10 的会话实测：72 次 edit 有 15 次失败（20.8%），而 read/write/todo 等零失败；
 * 逐条核对那 10 次 "Could not find"，全部是 oldText 从未出现在它自己读过的任何片段里
 * （模型读的是带 offset/limit 的小片段，然后凭记忆写整段）。
 *
 * 直接改 pi 内置 edit 不可行（runtime/versions 是打包产物，升级即被覆盖），
 * 而 pi 的 tool_result 事件允许扩展**改写**结果（runner.js: content/isError 都可被替换），
 * 所以这里不动匹配逻辑，只在失败后补一段「你写的 vs 文件里的」对照。
 *
 * 上游状态（2026-11-10 核对）
 * ---------------------------
 * 同类诉求在 pi 仓库是 issue #8654，被机器人按「新贡献者自动关闭」处理（label: no-action），
 * 维护者未评审；GitHub main 分支的 edit-diff.ts 至今没有最接近片段/行号提示。
 * 第三方 pi-semantic-edit 实现了它（本文件的 findClosestCandidate 即照其 closest.ts 的思路），
 * 但那套会**整体接管 edit 的匹配行为**——风险高于收益，故这里只取「失败后回显」。
 *
 * 为什么独立成文件并被 ?raw 打包
 * -----------------------------
 * 与其它 mpi-*-ext.ts 一致：主进程把它作为字符串写进 userData，再以 `pi --extension` 加载，
 * 所以必须自包含（不能 import 本仓其它模块），且只依赖 Node 内置模块。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

/** 只在「找不到文本」时介入；重复匹配（Found N occurrences）是另一类问题，不在这里处理。 */
const NOT_FOUND_RE = /Could not find (?:the exact text in|edits\[(\d+)\] in) (.+?)(?:\. The old|$)/;

/**
 * 「文件打不开」：ENOENT 型错误。
 *
 * pi 的 normalizeWindowsShellPath（dist/utils/paths.js）只认 `/e/x` 与 `/mnt/e/x`，
 * 对 `/e:/x` 与 `e:/x` 两种写法原样交给系统 → ENOENT。
 * 2026-11-10 实测：72 次 edit 里有 3 次失败属于这一类（`/e:/…`、`unused`）。
 * `unused` 是模型把占位符当路径，无法自动救；但路径写法类可以。
 */
const EDIT_FILE_OPEN_FAIL_RE = /Could not (?:edit|find) file: (.+?)\. Error code: (ENOENT|EACCES)/;

/**
 * 把 Git Bash / 小写盘符写法转成 Windows 接受的形式。
 *
 * 与 pi 自带函数互补而非替代：`/e/x` 那一种它已经处理得很好，这里只管它漏的两种。
 */
export function fixDrivePath(input: string): string {
  const text = input.trim();
  // Git Bash 与 Windows 盘符混写：/e:/x 或 /e:x
  const mixed = /^\/([a-zA-Z]):[\\/]?(.*)$/.exec(text);
  if (mixed) return mixed[1].toUpperCase() + ":\\" + (mixed[2] ?? "").replaceAll("/", "\\");
  // 小写盘符：e:/x（Windows API 不认小写盘符后的正斜杠组合）
  const lower = /^([a-zA-Z]):[\\/](.*)$/.exec(text);
  if (lower) return lower[1].toUpperCase() + ":\\" + lower[2].replaceAll("/", "\\");
  return text;
}

/** 从「文件打不开」错误里取出被拒的路径。 */
function parseOpenFailure(message: string): string | null {
  const match = EDIT_FILE_OPEN_FAIL_RE.exec(message);
  return match ? match[1].trim() : null;
}

/** 单行相似度低于此值就认为不相关，避免把无关代码当成「最接近」。 */
const MIN_LINE_SIM = 0.3;
/** 整体相似度下限（与 pi-semantic-edit 的 MIN_CLOSEST_SIM 对齐）：太低的候选不展示。 */
const MIN_OVERALL_SIM = 0.15;
/** 候选窗口最大高度 = oldText 行数的倍数，防止跨越大段无关代码。 */
const MAX_HEIGHT_FACTOR = 2;
/** 展开到错误信息里的原文行数上限，避免把长文件灌进上下文。 */
const MAX_SHOWN_LINES = 6;

/**
 * 归一化：统一换行 + 逐行去尾空白。
 * 与 pi 内置 fuzzy 匹配的归一化方向一致（NFKC + trimEnd），但不做全量 NFKC——
 * 这里只是展示给人和模型看，保持原文更易读。
 */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 编辑距离相似度（0..1），用于逐行比对。 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  // 长行截断：只比前 200 字符，成本可控且足够判断「是不是同一行」
  const x = a.length > 200 ? a.slice(0, 200) : a;
  const y = b.length > 200 ? b.slice(0, 200) : b;
  const m = x.length;
  const n = y.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return 1 - prev[n] / Math.max(m, n);
}

export interface ClosestHit {
  /** 文件里实际内容（行数组） */
  lines: string[];
  /** 起始行号（1 起） */
  startLine: number;
  /** 结束行号（1 起） */
  endLine: number;
  /** 综合相似度 0..1 */
  score: number;
  /** 逐行差异：你写的那行 vs 文件里那行，只保留相似度 < 1 的对 */
  diffs: { fileLine: number; yours: string; actual: string; sim: number }[];
}

/**
 * 在文件内容里找与 oldText 最接近的一段（行区间）。
 *
 * 算法（与 pi-semantic-edit 的 closest.ts 同思路，但砍掉了一半复杂度）：
 * ① 用首行/末行做锚点，找出可能的起始行（相似度 ≥ MIN_LINE_SIM）
 * ② 对每个锚点，在 MAX_HEIGHT_FACTOR 倍高度内滑动窗口，算「行对齐均分」
 * ③ 取最高分；低于 MIN_OVERALL_SIM 就认为不值得提示
 *
 * 之所以不照搬它的 LCS 对齐 + 字符级兜底：那套在一个候选上要做 O(行数²) 的 DP，
 * 而我们只在**出错后**调用一次，目标是「让模型看清差异」而不是「自动修正」。
 */
export function findClosest(fileText: string, oldText: string): ClosestHit | null {
  const file = normalize(fileText).split("\n");
  const old = normalize(oldText).trim().split("\n").map((line) => line.trimEnd());
  if (old.length === 0 || (old.length === 1 && old[0].length === 0)) return null;

  const simCache = new Map<string, number>();
  const lineSim = (oi: number, fi: number): number => {
    const key = `${oi}:${fi}`;
    let value = simCache.get(key);
    if (value === undefined) {
      value = similarity(old[oi].trim(), file[fi].trim());
      simCache.set(key, value);
    }
    return value;
  };

  // ① 锚点：首行或末行与文件某行相似度够高，就从这个位置开始试
  const anchors: number[] = [];
  const MAX_ANCHORS = 50;
  for (let i = 0; i < file.length && anchors.length < MAX_ANCHORS; i++) {
    if (lineSim(0, i) >= MIN_LINE_SIM || lineSim(old.length - 1, i) >= MIN_LINE_SIM) anchors.push(i);
  }
  if (anchors.length === 0) return null;

  // ② 滑动窗口打分：行对齐均分（允许窗口比 oldText 高，因为文件里可能多了空行/注释）
  const maxHeight = Math.max(1, old.length * MAX_HEIGHT_FACTOR);
  let best: { start: number; end: number; score: number } | null = null;
  for (const start of anchors) {
    for (let height = 1; height <= maxHeight && start + height <= file.length; height++) {
      let total = 0;
      // 直接逐行对齐（不做 LCS）：候选高度与 oldText 行数不同时按比例取样
      for (let i = 0; i < old.length; i++) {
        const fileIndex = start + Math.min(height - 1, Math.round((i * (height - 1)) / Math.max(1, old.length - 1)));
        total += lineSim(i, fileIndex);
      }
      const score = total / old.length;
      if (!best || score > best.score) best = { start, end: start + height - 1, score };
    }
  }
  if (!best || best.score < MIN_OVERALL_SIM) return null;

  // ③ 逐行差异：只报相似度 < 1 的（也就是真正不一致的行）
  const diffs: ClosestHit["diffs"] = [];
  for (let i = 0; i < old.length; i++) {
    const fileIndex = best.start + Math.min(best.end - best.start, Math.round((i * (best.end - best.start)) / Math.max(1, old.length - 1)));
    const sim = lineSim(i, fileIndex);
    if (sim < 1) diffs.push({ fileLine: fileIndex + 1, yours: old[i], actual: file[fileIndex], sim });
  }
  diffs.sort((a, b) => b.sim - a.sim);

  return {
    lines: file.slice(best.start, best.end + 1),
    startLine: best.start + 1,
    endLine: best.end + 1,
    score: best.score,
    diffs,
  };
}

/** 把候选渲染成给模型看的文本块（带行号、可复制）。 */
export function renderHint(hit: ClosestHit, path: string): string {
  const width = String(hit.endLine).length;
  const shown = hit.lines.slice(0, MAX_SHOWN_LINES);
  const body = shown
    .map((line, i) => `  ${String(hit.startLine + i).padStart(width, " ")} | ${line}`)
    .join("\n");
  const more = hit.lines.length > shown.length ? `\n  ...（共 ${hit.lines.length} 行）` : "";

  let text =
    `\n\n文件里最接近的一段在 ${path} 第 ${hit.startLine}–${hit.endLine} 行` +
    `（相似度 ${(hit.score * 100).toFixed(0)}%）：\n${body}${more}`;

  if (hit.diffs.length > 0) {
    const top = hit.diffs.slice(0, 3);
    text +=
      "\n\n不一致的行（你写的 → 文件里的）：\n" +
      top
        .map(
          (d) =>
            `  第 ${d.fileLine} 行（相似度 ${(d.sim * 100).toFixed(0)}%）\n` +
            `    你写的：${d.yours.trim().slice(0, 120)}\n` +
            `    文件里：${d.actual.trim().slice(0, 120)}`,
        )
        .join("\n");
  }

  text +=
    "\n\n提示：edit 的 oldText 必须逐字复制上面这段（含缩进）。" +
    "若你此前只读了该文件的一部分，请先 read 到包含这一段的区间再改。";
  return text;
}

/** 从错误文本里认出「哪个 path + 第几条 edits」。 */
function parseFailure(message: string): { path: string; editIndex: number | null } | null {
  const match = NOT_FOUND_RE.exec(message);
  if (!match) return null;
  return { path: match[2].trim(), editIndex: match[1] === undefined ? null : Number(match[1]) };
}

/** 从 tool_result 的 content 里拼出纯文本（pi 的 content 是块数组）。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: string }).text ?? "") : ""))
    .join("");
}

/**
 * 从 tool_result 事件里取 oldText：事件只带 input（参数），所以直接从 input.edits[editIndex] 取。
 * 取不到就没法比对——宁可不动结果，也不要拼一条空提示。
 */
function oldTextOf(input: unknown, editIndex: number | null): string | null {
  const edits = (input as { edits?: unknown } | null | undefined)?.edits;
  if (!Array.isArray(edits)) return null;
  const index = editIndex ?? 0;
  const target = edits[index] as { oldText?: unknown } | undefined;
  const oldText = target?.oldText;
  return typeof oldText === "string" && oldText.length > 0 ? oldText : null;
}

export default function mpiEditRecovery(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event: unknown, ctx: unknown) => {
    try {
      const payload = (event ?? {}) as {
        toolName?: string;
        isError?: boolean;
        content?: unknown;
        input?: unknown;
      };
      if (payload.toolName !== "edit" || payload.isError !== true) return;

      const message = textOf(payload.content);
      const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();

      // 第一类：路径写法导致文件打不开（pi 的 Git Bash 路径规范化漏了 /e:/ 与 e:/）。
      const rejectedPath = parseOpenFailure(message);
      if (rejectedPath !== null) {
        const fixed = fixDrivePath(rejectedPath);
        if (fixed === rejectedPath) return; // 不是可修的写法（如把占位符当路径），不动
        const absolute = isAbsolute(fixed) ? fixed : resolvePath(cwd, fixed);
        if (!existsSync(absolute)) return; // 改完仍不存在：不编造「应该用这个路径」
        const hint =
          `\n\n路径写法修正：${rejectedPath} → ${fixed}\n` +
          "（Windows 不认 `/e:/…` 这种 Git Bash 与盘符混写、也不认小写盘符。" +
          "请在下次调用里直接用上面的路径。）";
        return { content: [{ type: "text", text: message + hint }] };
      }

      // 第二类：oldText 在文件里找不到。
      const failure = parseFailure(message);
      if (!failure) return;

      const oldText = oldTextOf(payload.input, failure.editIndex);
      if (!oldText) return;

      // 即便原路径写法不对，也比对得先找到文件，否则模型看不到任何线索。
      const candidate = fixDrivePath(failure.path);
      const absolute = isAbsolute(candidate) ? candidate : resolvePath(cwd, candidate);
      const fileText = await readFile(absolute, "utf-8");

      const hit = findClosest(fileText, oldText);
      if (!hit) return;

      // 只追加，不改原文：模型仍能看到原始报错，也仍能自己决定重读还是改写。
      const enriched = message + renderHint(hit, failure.path);
      return { content: [{ type: "text", text: enriched }] };
    } catch {
      // 恢复指引是锦上添花：读文件失败、路径解析失败、事件形状变了——
      // 任何异常都不能让工具结果本身变成另一条错误。
      return;
    }
  });
}
