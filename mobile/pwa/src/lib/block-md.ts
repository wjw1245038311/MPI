/**
 * 块级 markdown（PWA）：标题 / 无序列表 / 有序列表 / 引用。
 *
 * 背景（2026-10-19 真机）：模型回复里的 `## 标题`、`- 列表项` 在手机端被原样打印，
 * 桌面端则是真标题与列表。行内语法已由 lib/inline.ts 处理，这里只补「块」。
 *
 * 取舍：只认最容易误伤的四类，其余一律当普通段落（保留 `white-space: pre-wrap` 的换行），
 * 不引入 markdown 依赖，也不做嵌套列表/表格（真需要时再逐项加，别一次做成半吊子）。
 */
export type MdBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[]; start: number }
  | { kind: "quote"; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const UL_ITEM = /^[-*+]\s+(.*)$/;
const OL_ITEM = /^(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

export function parseBlocks(raw: string): MdBlock[] {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
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

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushAll();
      continue;
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
      if (list && !list.ordered) list.items.push(ul[1].trim());
      else {
        flushList();
        list = { ordered: false, start: 1, items: [ul[1].trim()] };
      }
      continue;
    }
    const ol = OL_ITEM.exec(trimmed);
    if (ol) {
      flushPara();
      flushQuote();
      if (list && list.ordered) list.items.push(ol[2].trim());
      else {
        flushList();
        list = { ordered: true, start: Number(ol[1]) || 1, items: [ol[2].trim()] };
      }
      continue;
    }
    // 列表项的续行（缩进）仍然算同一项，避免把软换行拆成一堆段落。
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += "\n" + trimmed;
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
