/**
 * PWA 行内 markdown（2026-10-19 真机：手机端正文里 `**重点**` 原样显示成星号，桌面端没有）。
 *
 * 契约：粗体 / 行内代码 / 斜体三种，都不跨行；行首的列表符号不会被误判成斜体；
 * 代码段里的 `**` 保持字面。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { parseInline } = await import("../mobile/pwa/src/lib/inline.ts");

const kinds = (text) => parseInline(text).map((t) => `${t.kind}:${t.text}`);

// 1) 粗体
assert.deepEqual(kinds("这是 **重点** 内容"), ["text:这是 ", "bold:重点", "text: 内容"]);
console.log("[1] 粗体");

// 2) 行内代码（里面的 ** 不当标记）
assert.deepEqual(kinds("跑 `a ** b` 试试"), ["text:跑 ", "code:a ** b", "text: 试试"]);
console.log("[2] 行内代码");

// 3) 斜体（星号与下划线两种写法）
assert.deepEqual(kinds("这是 *斜体* 和 _也是_"), ["text:这是 ", "italic:斜体", "text: 和 ", "italic:也是"]);
console.log("[3] 斜体");

// 4) 列表符号（行首 * + 空格，没有闭合标记）不能被当成斜体
assert.deepEqual(kinds("* 第一项\n* 第二项"), ["text:* 第一项\n* 第二项"]);
console.log("[4] 列表符号保持原样");

// 5) 未闭合的标记原样保留（流式中间态常见）
assert.deepEqual(kinds("还没写完 **粗"), ["text:还没写完 **粗"]);
assert.deepEqual(kinds("单个 * 号"), ["text:单个 * 号"]);
console.log("[5] 未闭合标记不吞字");

// 6) 不跨行匹配
assert.deepEqual(kinds("**第一行\n第二行**"), ["text:**第一行\n第二行**"]);
console.log("[6] 不跨行");

// 7) 空串与纯文本
assert.deepEqual(parseInline(""), []);
assert.deepEqual(kinds("普通文本"), ["text:普通文本"]);
console.log("[7] 空串 / 纯文本");

console.log("pwa-inline：7 项全部通过");
