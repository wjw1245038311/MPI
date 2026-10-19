/**
 * PWA 块级 markdown（2026-10-19：`## 标题`、`- 列表项`、`| 表格 |` 在手机上是原样字符）。
 *
 * 契约：标题（1-6 级）/ 无序列表（-、*、+，支持按缩进嵌套）/ 有序列表（1. 或 1)）/
 * 引用（>）/ GFM 表格 / 段落；其余一律当段落（保留换行，不误伤）。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { parseBlocks } = await import("../mobile/pwa/src/lib/block-md.ts");

// 1) 标题
assert.deepEqual(parseBlocks("## 三件需要你定的事"), [{ kind: "h", level: 2, text: "三件需要你定的事" }]);
assert.deepEqual(parseBlocks("### 深一层").map((b) => b.level), [3]);
console.log("[1] 标题");

// 2) 无序列表（三种符号都认；深度按缩进）
assert.deepEqual(parseBlocks("- A\n- B\n* C\n+ D"), [
  { kind: "ul", items: [{ text: "A", depth: 0 }, { text: "B", depth: 0 }, { text: "C", depth: 0 }, { text: "D", depth: 0 }] },
]);
console.log("[2] 无序列表");

// 3) 嵌套列表：2 空格 = 1 级
assert.deepEqual(parseBlocks("- 顶层\n  - 子项\n    - 孙项"), [
  { kind: "ul", items: [{ text: "顶层", depth: 0 }, { text: "子项", depth: 1 }, { text: "孙项", depth: 2 }] },
]);
console.log("[3] 嵌套列表");

// 4) 有序列表（保留起始序号；嵌套也按缩进）
assert.deepEqual(parseBlocks("1. 甲\n2. 乙"), [
  { kind: "ol", items: [{ text: "甲", depth: 0 }, { text: "乙", depth: 0 }], start: 1 },
]);
assert.deepEqual(parseBlocks("3) 丙\n4) 丁"), [
  { kind: "ol", items: [{ text: "丙", depth: 0 }, { text: "丁", depth: 0 }], start: 3 },
]);
console.log("[4] 有序列表");

// 5) 段落 + 列表混排
{
  const blocks = parseBlocks("先说明一句：\n\n- 要点一\n- 要点二\n\n最后总结。");
  assert.deepEqual(blocks.map((b) => b.kind), ["p", "ul", "p"]);
  assert.equal(blocks[0].text, "先说明一句：");
  assert.equal(blocks[2].text, "最后总结。");
}
console.log("[5] 段落与列表混排");

// 6) 列表项续行（缩进但非列表项）并入同一项
{
  const blocks = parseBlocks("- 第一项\n  继续说明\n- 第二项");
  assert.deepEqual((blocks[0]).items.map((i) => i.text), ["第一项\n继续说明", "第二项"]);
}
console.log("[6] 列表项续行");

// 7) 引用
assert.deepEqual(parseBlocks("> 引用一句\n> 第二行"), [{ kind: "quote", text: "引用一句\n第二行" }]);
console.log("[7] 引用");

// 8) GFM 表格（含对齐标记）
{
  const blocks = parseBlocks("| 名称 | 值 |\n|:---|---:|\n| A | 1 |\n| B | 2 |");
  assert.equal(blocks.length, 1);
  const table = blocks[0];
  assert.equal(table.kind, "table");
  assert.deepEqual(table.header, ["名称", "值"]);
  assert.deepEqual(table.align, ["left", "right"]);
  assert.deepEqual(table.rows, [["A", "1"], ["B", "2"]]);
}
console.log("[8] GFM 表格");

// 9) 表格里的转义竖线
{
  const table = parseBlocks("| a |\n|---|\n| x \\| y |")[0];
  assert.deepEqual(table.rows, [["x | y"]]);
}
console.log("[9] 转义竖线");

// 10) 纯文本/空串/行内标记不被拆坏
assert.deepEqual(parseBlocks(""), []);
assert.deepEqual(parseBlocks("就是一句话"), [{ kind: "p", text: "就是一句话" }]);
assert.deepEqual(parseBlocks("第一行\n第二行"), [{ kind: "p", text: "第一行\n第二行" }]);
assert.deepEqual(parseBlocks("**重点**"), [{ kind: "p", text: "**重点**" }]);
console.log("[10] 纯文本 / 空串 / 行内标记");

console.log("pwa-blocks：10 项全部通过");
