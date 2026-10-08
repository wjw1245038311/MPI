/**
 * 用户消息里的机器注解清理（桌面端 `src/shared/image-notes.ts` 的移植）。
 *
 * pi 处理图片附件时会把缩放/转换注解追加到用户正文末尾：
 *
 *   [Image: original 2548x402, displayed at 2000x316. Multiply coordinates by 1.27
 *    to map to original image.]
 *   [Image converted from image/heic to image/png.]
 *
 * 只在图片被缩放过时才加（大图必中）——所以「发带图的话」经常命中。两个后果：
 *   1. 气泡里露出这行不是用户写的英文文本；
 *   2. `message_start` 把乐观回显「转正」时是按**文本相等**对账的，多出注解就
 *      永远失配 → 同一条消息上屏两次。
 *
 * 快照里的文本已由主机剥过（main/ipc.ts 的 remote 构建），但**实时事件通道**
 * 是原样转发 pi 事件的，所以客户端必须自己再剥一次。
 *
 * 两个函数各管一层：`stripImageDimensionNotes` 用于**显示**（`[Image omitted: …]`
 * 保留，那是给用户看的原因说明）；`stripImageHints` 用于**对账**（5 种注解全剥）。
 */

const DIMENSION_NOTE_RE =
  /^[ \t]*\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\][ \t\r]*$/gm;

/** ② 图片被转格式的注解。 */
const CONVERTED_NOTE_RE = /^[ \t]*\[Image converted from [^\]]*\][ \t\r]*$/gm;

/** ③④⑤ 图片没能内联成功的原因说明（显示保留、对账剥掉）。 */
const OMITTED_NOTE_RE = /^[ \t]*\[Image omitted: [^\]]*\][ \t\r]*$/gm;

const DIMENSION_MARKER = "[Image: original ";
const CONVERTED_MARKER = "[Image converted from ";

/**
 * 剥掉「图片已带上」的机器注解（① 缩放坐标 / ② 转格式）。
 * 这是**显示用**的那个：`[Image omitted: …]` 故意保留（那是给用户看的原因说明）。
 * 与桌面端 `src/shared/image-notes.ts` 逐字对齐。
 */
export function stripImageDimensionNotes(text: string): string {
  if (!text.includes(DIMENSION_MARKER) && !text.includes(CONVERTED_MARKER)) return text;
  return text
    .replace(DIMENSION_NOTE_RE, "")
    .replace(CONVERTED_NOTE_RE, "")
    .replace(/[ \t\r\n]+$/, "");
}

/**
 * 剥掉 **全部** 图片注解（含 ③④⑤「图片没能内联」的原因说明）——**对账用**：
 * `message_start` 把乐观回显转正时按文本相等比较，多一行注解就永远失配（气泡重复）。
 */
export function stripImageHints(text: string): string {
  // 标记里**不带空格**：缩放注解开头是 `[Image: original`（冒号）。
  if (!text.includes("[Image")) return text;
  return stripImageDimensionNotes(text.replace(OMITTED_NOTE_RE, "")).replace(/[ \t\r\n]+$/, "");
}
