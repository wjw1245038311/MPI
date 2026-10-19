/**
 * PWA 块级 markdown（2026-10-19：`## 标题`、`- 列表项` 在手机上是原样字符，桌面是标题/列表）。
 *
 * 契约：标题（1-6 级）/ 无序列表（-、*、+）/ 有序列表（1. 或 1)）/ 引用（>）/ 段落；
 * 其余一律当段落（保留换行，不误伤）。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { parseBlocks } = await import("../mobile/pwa/src/lib/block-md.ts");

// 1) 标题
assert.deepEqual(parseBlocks("## 三件需要你定的事"), [{ kind: "h", level: 2, text: "三件需要你定的事" }]);
assert.deepEqual(parseBlocks("### 深一层").map((b) => b.level), [3]);
console.log("[1] 标题");

// 2) 无序列表（三种符号都认，连续行合并成一个列表）
assert.deepEqual(parseBlocks("- A\n- B\n* C\n+ D"), [{ kind: "ul", items: ["A", "B", "C", "D"] }]);
console.log("[2] 无序列表");

// 3) 有序列表（保留起始序号）
assert.deepEqual(parseBlocks("1. 甲\n2. 乙"), [{ kind: "ol", items: ["甲", "乙"], start: 1 }]);
assert.deepEqual(parseBlocks("3) 丙\n4) 丁"), [{ kind: "ol", items: ["丙", "丁"], start: 3 }]);
console.log("[3] 有序列表");

// 4) 段落 + 列表混排（空行/非列表行结束列表）
{
  const blocks = parseBlocks("先说明一句：\n\n- 要点一\n- 要点二\n\n最后总结。");
  assert.deepEqual(blocks.map((b) => b.kind), ["p", "ul", "p"]);
  assert.equal(blocks[0].text, "先说明一句：");
  assert.equal(blocks[2].text, "最后总结。");
}
console.log("[4] 段落与列表混排");

// 5) 列表项续行（缩进）并入同一项
{
  const blocks = parseBlocks("- 第一项\n  继续说明\n- 第二项");
  assert.deepEqual(blocks[0].items, ["第一项\n继续说明", "第二项"]);
}
console.log("[5] 列表项续行");

// 6) 引用
assert.deepEqual(parseBlocks("> 引用一句\n> 第二行"), [{ kind: "quote", text: "引用一句\n第二行" }]);
console.log("[6] 引用");

// 7) 纯文本/空串不被拆坏
assert.deepEqual(parseBlocks(""), []);
assert.deepEqual(parseBlocks("就是一句话"), [{ kind: "p", text: "就是一句话" }]);
assert.deepEqual(parseBlocks("第一行\n第二行"), [{ kind: "p", text: "第一行\n第二行" }]);
console.log("[7] 纯文本 / 空串");

// 8) 行内的 * 不会被当成列表（`**粗体**` 单独一行仍是段落）
assert.deepEqual(parseBlocks("**重点**"), [{ kind: "p", text: "**重点**" }]);
console.log("[8] 行内标记不误判成列表");

console.log("pwa-blocks：8 项全部通过");
