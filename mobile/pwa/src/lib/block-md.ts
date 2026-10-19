/**
 * 块级 markdown（PWA）：标题 / 无序/有序列表（支持嵌套）/ 引用 / 表格 / 段落。
 *
 * 背景（2026-10-19 真机）：模型回复里的 `## 标题`、`- 列表项`、`| 表头 |` 在手机端被原样
 * 打印，桌面端则是真标题、列表与表格。行内语法见 lib/inline.ts，这里只补「块」。
 *
 * 取舍：
 *   · 列表嵌套**按缩进深度**表示（2 空格 = 1 级，最多 4 级），不做任意深的树——
 *     模型输出极少超过两层，树结构反而更容易在流式中途出错。
 *   · 表格只认 GFM 的 `| a | b |` + `|---|---|` 两行式，对齐标记支持但只影响文字对齐。
 *   · 其余一律当普通段落（保留换行），不引 markdown 依赖。
 */
export interface MdListItem {
  text: string;
  /** 嵌套深度，0 = 顶层。 */
  depth: number;
}

export type TableAlign = "left" | "center" | "right" | null;

export type MdBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "ul"; items: MdListItem[] }
  | { kind: "ol"; items: MdListItem[]; start: number }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; align: TableAlign[]; rows: string[][] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const UL_ITEM = /^([-*+])\s+(.*)$/;
const OL_ITEM = /^(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

/** 行首缩进 → 嵌套深度（2 空格一级，最多 4 级）。 */
function depthOf(line: string): number {
  const spaces = /^(\s*)/.exec(line)?.[1].replace(/\t/g, "  ").length ?? 0;
  return Math.min(4, Math.floor(spaces / 2));
}

/** `| a | b |` → ["a","b"]（去掉首尾空项；反斜杠转义的 `\|` 原样保留在单元格里）。 */
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function alignOf(separator: string): TableAlign[] {
  return splitRow(separator).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center" as const;
    if (right) return "right" as const;
    if (left) return "left" as const;
    return null;
  });
}

export function parseBlocks(raw: string): MdBlock[] {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: MdListItem[] } | null = null;
  let quote: string[] | null = null;

  const flushPara = () => {
    if (!para.length) return;
    const body = para.join("\n");
    if (body.trim()) blocks.push({ kind: "p", text: body });
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(
      list.ordered
        ? { kind: "ol", items: list.items, start: list.start }
        : { kind: "ul", items: list.items },
    );
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    const body = quote.join("\n");
    if (body.trim()) blocks.push({ kind: "quote", text: body });
    quote = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flushAll();
      continue;
    }

    // 表格：当前行以 | 开头，且下一行是分隔行
    if (trimmed.startsWith("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1].trim())) {
      const header = splitRow(trimmed);
      const align = alignOf(lines[i + 1].trim());
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i].trim()));
        i++;
      }
      i--; // for 循环会再 ++
      if (header.length) {
        flushAll();
        blocks.push({ kind: "table", header, align, rows });
        continue;
      }
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      flushAll();
      blocks.push({ kind: "h", level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, text: heading[2].trim() });
      continue;
    }

    const quoteMatch = QUOTE.exec(trimmed);
    if (quoteMatch) {
      flushPara();
      flushList();
      quote = quote ? [...quote, quoteMatch[1]] : [quoteMatch[1]];
      continue;
    }

    const ul = UL_ITEM.exec(trimmed);
    if (ul) {
      flushPara();
      flushQuote();
      const depth = depthOf(line);
      if (list && !list.ordered) list.items.push({ text: ul[2].trim(), depth });
      else {
        flushList();
        list = { ordered: false, start: 1, items: [{ text: ul[2].trim(), depth }] };
      }
      continue;
    }

    const ol = OL_ITEM.exec(trimmed);
    if (ol) {
      flushPara();
      flushQuote();
      const depth = depthOf(line);
      if (list && list.ordered) list.items.push({ text: ol[2].trim(), depth });
      else {
        flushList();
        list = { ordered: true, start: Number(ol[1]) || 1, items: [{ text: ol[2].trim(), depth }] };
      }
      continue;
    }

    // 列表项的续行（缩进 2+ 空格且不是新的列表项）并入同一项
    if (list && /^\s{2,}\S/.test(line)) {
      const item = list.items[list.items.length - 1];
      item.text += "\n" + trimmed;
      continue;
    }

    if (quote) {
      quote.push(trimmed);
      continue;
    }
    flushList();
    flushQuote();
    para.push(line);
  }
  flushAll();
  return blocks;
}
