/**
 * 行内 markdown（PWA）：粗体 / 行内代码 / 斜体。
 *
 * 背景（2026-10-19 真机）：手机端正文是**纯文本原样打印**（只切代码围栏），于是模型
 * 输出里的 `**重点**` 全都显示成字面的星号；桌面端走完整 markdown 渲染，看不到这些
 * 星号。安卓原生端早就实现了 `**` 与行内代码（见 MessageContent.splitInline），
 * PWA 这边缺了同一层，这里补齐。
 *
 * 只做三件事，不引 markdown 依赖：
 *   · `**粗体**` → <strong>
 *   · `` `代码` `` → <code>（代码里的 ** 不再当标记）
 *   · `*斜体*` / `_斜体_` → <em>
 * 列表符号（行首 `* `/`- `）没有闭合标记，不会被误判成斜体。
 */
export type InlineKind = "text" | "bold" | "italic" | "code";

export interface InlineToken {
  kind: InlineKind;
  text: string;
}

/** 依次匹配：粗体 → 行内代码 → 斜体（星号/下划线）。都不跨行。 */
const INLINE = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\*[^*\s\n][^*\n]*\*)|(_[^_\s\n][^_\n]*_)/g;

export function parseInline(raw: string): InlineToken[] {
  const text = typeof raw === "string" ? raw : "";
  if (!text) return [];
  const out: InlineToken[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match; match = INLINE.exec(text)) {
    const start = match.index;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    const token = match[0];
    if (token.startsWith("**")) out.push({ kind: "bold", text: token.slice(2, -2) });
    else if (token.startsWith("`")) out.push({ kind: "code", text: token.slice(1, -1) });
    else out.push({ kind: "italic", text: token.slice(1, -1) });
    last = start + token.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
