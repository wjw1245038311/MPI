/**
 * §4.5 审批卡 diff 扩展（v1 兼容）——主机端。
 *
 * 权限门对 write/edit 类审批发出的 ui.request，其标题是稳定契约：
 *   "Permission required: <tool>\n<reason>\n\n<detail>"（zh："权限确认：<tool>…"）
 * detail 通常是 redactInput(event.input) —— 工具入参的 JSON 文本。本模块解析该
 * 标题，能取到新旧内容时计算 unified diff 附进 ui.request payload.diff：
 *   { path, added, removed, hunks }（hunks ≤50KB，超限截断带省略标记）
 * 其他类型审批不带该字段；RemoteUiRequest 本就含 [key: string]: unknown，旧客户端
 * 忽略未知字段，无需 bump 协议版本。PWA 无 diff 时降级纯文本卡。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface ApprovalDiff {
  /** 工具入参里的原始（相对）路径，用于展示 */
  path: string;
  added: number;
  removed: number;
  /** unified diff 文本；超限时截断并带省略标记 */
  hunks: string;
}

const MAX_HUNKS_BYTES = 50 * 1024; // §4.5：总量 ≤50KB
const MAX_SIDE_LINES = 2000; // LCS DP 尺寸守卫（~16MB 表）
const MAX_SIDE_BYTES = 512 * 1024;

/** 解析审批标题 → {tool, detail}；非审批请求返回 null。 */
export function parseApprovalHeading(heading: string): { tool: string; detail: string } | null {
  const m = /^(?:Permission required|权限确认)[:：]\s*(\S+)\n([\s\S]*?)(?:\n\n([\s\S]*))?$/.exec(heading);
  if (!m) return null;
  return { tool: m[1], detail: (m[3] ?? "").trim() };
}

function applyEdits(content: string, edits: unknown): string | undefined {
  if (!Array.isArray(edits)) return undefined;
  let out = content;
  for (const e of edits) {
    const oldText = typeof e?.oldText === "string" ? e.oldText : "";
    const newText = typeof e?.newText === "string" ? e.newText : "";
    if (!oldText || !out.includes(oldText)) return undefined; // 无法安全应用 → 放弃 diff
    out = out.replace(oldText, newText);
  }
  return out;
}

interface DiffLine {
  sign: " " | "+" | "-";
  text: string;
}

/** 行级 LCS diff（尺寸守卫由调用方保证）。返回操作序列 + 统计。 */
function lcsDiff(aLines: string[], bLines: string[]): { lines: DiffLine[]; added: number; removed: number } {
  const n = aLines.length;
  const m = bLines.length;
  // DP：dp[i][j] = LCS(aLines[i:], bLines[j:])，自底向上。
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = aLines[i] === bLines[j] ? dp[(i + 1) * (m + 1) + (j + 1)] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
    }
  }
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      lines.push({ sign: " ", text: aLines[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) {
      lines.push({ sign: "-", text: aLines[i] });
      removed++;
      i++;
    } else {
      lines.push({ sign: "+", text: bLines[j] });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ sign: "-", text: aLines[i++] });
    removed++;
  }
  while (j < m) {
    lines.push({ sign: "+", text: bLines[j++] });
    added++;
  }
  return { lines, added, removed };
}

/** 操作序列 → unified hunks（3 行上下文）。 */
function toUnifiedHunks(lines: DiffLine[]): string {
  const ctx = 3;
  // 找出所有变更行的下标，扩展成带上下文的区间。
  const ranges: Array<[number, number]> = [];
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].sign === " ") continue;
    const start = Math.max(0, k - ctx);
    const end = Math.min(lines.length - 1, k + ctx);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  if (!ranges.length) return ""; // 无变更
  const out: string[] = [];
  for (const [start, end] of ranges) {
    let oldStart = 1;
    let newStart = 1;
    let oldCount = 0;
    let newCount = 0;
    for (let k = 0; k < start; k++) {
      if (lines[k].sign !== "+") oldStart++;
      if (lines[k].sign !== "-") newStart++;
    }
    for (let k = start; k <= end; k++) {
      const l = lines[k];
      if (l.sign !== "+") oldCount++;
      if (l.sign !== "-") newCount++;
      out.push(`${l.sign}${l.text}`);
    }
    out.splice(out.length - (end - start + 1), 0, `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
  }
  return out.join("\n");
}

/**
 * 从审批标题计算 write/edit diff（best-effort：任何取不到内容的情况返回 undefined，
 * PWA 降级纯文本卡）。永不抛错。
 */
export async function buildApprovalDiff(cwd: string, heading: string): Promise<ApprovalDiff | undefined> {
  try {
    const parsed = parseApprovalHeading(heading);
    if (!parsed || (parsed.tool !== "write" && parsed.tool !== "edit")) return undefined;
    let input: any;
    try {
      input = JSON.parse(parsed.detail);
    } catch {
      return undefined; // detail 是裸路径（敏感/通配符场景）或被截断 → 无内容可 diff
    }
    const relPath = typeof input?.path === "string" ? input.path : "";
    if (!relPath || /[*?[\]{}]/.test(relPath)) return undefined; // 通配符无法确认范围
    let abs: string;
    try {
      abs = path.resolve(cwd, relPath);
    } catch {
      return undefined;
    }
    let oldContent = "";
    try {
      oldContent = readFileSync(abs, "utf8");
    } catch {
      /* 新文件：old = "" */
    }
    if (Buffer.byteLength(oldContent, "utf8") > MAX_SIDE_BYTES) return undefined;
    let newContent: string;
    if (parsed.tool === "write") {
      const content = typeof input.content === "string" ? input.content : undefined;
      if (content === undefined) return undefined;
      newContent = content;
    } else {
      const applied = applyEdits(oldContent, input.edits);
      if (applied === undefined) return undefined;
      newContent = applied;
    }
    if (Buffer.byteLength(newContent, "utf8") > MAX_SIDE_BYTES) return undefined;
    const aLines = oldContent.split("\n");
    const bLines = newContent.split("\n");
    if (aLines.length > MAX_SIDE_LINES || bLines.length > MAX_SIDE_LINES) return undefined;
    const { lines, added, removed } = lcsDiff(aLines, bLines);
    let hunks = toUnifiedHunks(lines);
    if (!hunks) return undefined; // 内容无变化（如 edit 未命中）→ 不附 diff
    if (Buffer.byteLength(hunks, "utf8") > MAX_HUNKS_BYTES) {
      const marker = "\n…（diff 超限截断，完整内容见桌面端）";
      const keep = Math.max(0, MAX_HUNKS_BYTES - Buffer.byteLength(marker, "utf8"));
      hunks = Buffer.from(hunks, "utf8").subarray(0, keep).toString("utf8") + marker;
    }
    return { path: relPath, added, removed, hunks };
  } catch {
    return undefined;
  }
}

/** ui.request 转发到远端前的字段白名单（纯函数，便于单测）。diff 为 §4.5 扩展字段。 */
export function sanitizeRemoteUiRequest(request: Record<string, unknown>): Record<string, unknown> {
  const allowed = ["id", "method", "title", "message", "options", "placeholder", "prefill", "notifyType", "timeout", "diff"];
  const out: Record<string, unknown> = {};
  for (const key of allowed) if (key in request) out[key] = request[key];
  return out;
}
