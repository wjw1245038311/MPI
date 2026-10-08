/**
 * pi 图片注解清理（`[Image: original … Multiply coordinates …]`）——三端同源守卫。
 *
 * 背景（2026-10 反馈「发带图片的对话经常这样，三端都出现过」）：pi 给带图片的
 * 用户消息追加一段缩放注解（只在图片被缩放过时加，大图必中）。它有两个后果：
 *
 *   1. 气泡里露出这行不是用户写的英文文本；
 *   2. **同一条消息上屏两次**——各端把「乐观回显」转正时都按文本相等对账
 *      （桌面 store 的 message_start、PWA / 安卓 ThreadSession 同构），多出注解
 *      就永远失配，于是回显留着、主机那条又追加进来。
 *
 * 这里钉死：① shared 的实现本身；② 桌面的 parseUserMessage 必须把注解从可见文本里
 * 剥掉（对账用的就是它的结果）；③ PWA 的移植版与 shared 逐字等价（三端不能漂移）。
 * 安卓侧有等价的 ImageNotesTest.kt。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

const shared = await import("../src/shared/image-notes.ts");
const pwa = await import("../mobile/pwa/src/lib/user-text.ts");
const { parseUserMessage } = await import("../src/renderer/src/store.ts");

/** pi `formatDimensionNote` 的真实格式（utils/image-resize.ts）。 */
const NOTE =
  "[Image: original 2548x402, displayed at 2000x316. Multiply coordinates by 1.27 to map to original image.]";
const note = (text) => `${text}\n\n${NOTE}`;

// --- 1. shared 实现 ---------------------------------------------------------
{
  assert.equal(shared.stripImageDimensionNotes(note("帮我看看这个")), "帮我看看这个");
  // 幂等：剥过再剥不变
  assert.equal(shared.stripImageDimensionNotes(shared.stripImageDimensionNotes(note("x"))), "x");
  // 没有注解时原样返回（含前后空白的正文不动）
  assert.equal(shared.stripImageDimensionNotes("  纯文本\n\n第二段  "), "  纯文本\n\n第二段  ");
  // 注解夹在正文中间（pi 有时把注解插在附件引用之前）也剥得掉
  assert.equal(shared.stripImageDimensionNotes(`第一段\n${NOTE}\n第二段`), "第一段\n\n第二段");
  // CRLF：注解行以 \r 结尾也要认
  assert.equal(shared.stripImageDimensionNotes(`正文\r\n\r\n${NOTE}\r\n`), "正文");
  // 只有注解（image-only 消息）→ 空串（气泡不显示空气泡文本）
  assert.equal(shared.stripImageDimensionNotes(NOTE), "");
  // 用户自己写的方括号文本不受影响
  const mine = "[Image: 我自己的说明] 和 [Image: original 100x100]";
  assert.equal(shared.stripImageDimensionNotes(mine), mine);
  // 图片没内联成功时的原因说明**故意保留**（剥了就只剩一个空气泡）
  const omitted = "[Image omitted: could not be resized below the inline image size limit.]";
  assert.equal(shared.stripImageDimensionNotes(omitted), omitted);
  console.log("ok 1 - shared stripImageDimensionNotes");
}

// --- 2. 桌面 parseUserMessage（对账与显示都靠它） ----------------------------
{
  const parsed = parseUserMessage(note("mpi这个问题老是出现，能否彻底修复"));
  assert.equal(parsed.text, "mpi这个问题老是出现，能否彻底修复", "可见文本里不能再有注解");
  assert.equal(parsed.attachments.length, 0);

  // 对账等价性：主机回显（带注解）与乐观回显（用户输入）必须归一成同一段文本，
  // 否则 message_start 里 matchesOptimisticUserMessage 会失配 → 气泡重复。
  const typed = "带图的问题";
  assert.equal(parseUserMessage(note(typed)).text.trim(), typed.trim());
  // 与附件信封共存时也只剩正文本（<file> 该变成附件，注解该消失）
  const withFile = parseUserMessage(`问题文本\n\n<file name="a.txt" path="/tmp/a.txt" />\n\n${NOTE}`);
  assert.equal(withFile.text, "问题文本");
  assert.equal(withFile.attachments.length, 1);
  console.log("ok 2 - 桌面 parseUserMessage 剥注解（修复重复气泡的对账）");
}

// --- 3. PWA 移植版与 shared 等价 --------------------------------------------
{
  const cases = [
    note("帮我看看这个"),
    `第一段\n${NOTE}\n第二段`,
    `正文\r\n\r\n${NOTE}\r\n`,
    NOTE,
    "没有注解的普通文本",
    "[Image omitted: …]",
  ];
  for (const input of cases) {
    // 两个函数都要比（显示层与对账层都可能漂移）
    assert.equal(pwa.stripImageDimensionNotes(input), shared.stripImageDimensionNotes(input), `dim ${JSON.stringify(input.slice(0, 40))}`);
    assert.equal(pwa.stripImageHints(input), shared.stripImageHints(input), `hints ${JSON.stringify(input.slice(0, 40))}`);
  }
  // 对账层必须能把「带注解的主机回显」归一成用户输入（这是防重复气泡的关键）
  assert.equal(pwa.stripImageHints(note("问题")).trim(), "问题");
  assert.equal(pwa.stripImageHints('[Image omitted: x]' + String.fromCharCode(10, 10) + '问题').includes("[Image omitted"), false);
  console.log("ok 3 - PWA 两个函数与 shared 等价");
}

// --- 4. 对账用 stripImageHints：5 种注解全剥 ------------------------------------
{
  const hintKinds = [
    NOTE,
    "[Image converted from image/heic to image/png.]",
    "[Image omitted: could not be resized below the inline image size limit.]",
    "[Image omitted: could not be converted to a supported inline image format.]",
    "[Image omitted: configure an imageProcessor to convert BMP images.]",
  ];
  for (const hint of hintKinds) {
    // 对账：带注解的主机回显必须归一成用户输入的那一句
    assert.equal(shared.stripImageHints(note("带图的问题").replace(NOTE, hint)).trim(), "带图的问题");
    // 显示：缩放/转格式两种要剥，三种 omitted 保留（那是给用户看的原因说明）
    const displayed = shared.stripImageDimensionNotes(note("带图的问题").replace(NOTE, hint)).trim();
    // 显示层：omitted 说明保留（连同用户正文），缩放/转格式两种剥掉
    if (hint.startsWith("[Image omitted")) assert.equal(displayed, `带图的问题

${hint}`);
    else assert.equal(displayed, "带图的问题");
  }
  assert.equal(shared.stripImageHints("普通文本"), "普通文本");
  // 桌面 parseUserMessage 走的是「显示」那一层：omitted 说明要留着
  const omitted = "[Image omitted: could not be resized below the inline image size limit.]";
  assert.equal(parseUserMessage(note("带图的问题").replace(NOTE, omitted)).text, `带图的问题

${omitted}`);
  console.log("ok 4 - stripImageHints / 显示层对 omitted 说明的保留");
}

console.log("image-notes: all assertions passed");
