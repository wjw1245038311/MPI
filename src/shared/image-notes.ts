/**
 * pi 运行时给「带图片的消息」追加的机器注解（`utils/image-resize.ts` 的
 * `formatDimensionNote`）：
 *
 *   [Image: original 2548x402, displayed at 2000x316. Multiply coordinates by 1.27
 *    to map to original image.]
 *
 * 它是给模型做坐标换算用的，**只在图片被缩放过时才出现**——大图必中，所以
 * 「发带图片的话」会经常命中。留在气泡里有两个后果：
 *
 *   1. 用户看到一行不是自己写的英文括号文本（图片明明就在旁边）；
 *   2. 更要命：各端的「乐观回显 vs 主机回显」对账都按**文本相等**判断
 *      （桌面 store 的 matchesOptimisticUserMessage、PWA / 安卓 ThreadSession 的
 *      message_start 处理），多出这段注解就永远失配 → 同一条消息上屏两次
 *      （三端同样，2026-10 反馈「发带图片的对话经常这样，三端都出现过」）。
 *
 * 主进程（remote 快照）与渲染层（parseUserMessage）共用这一份；手机两端各自复制
 * 一份等价实现（PWA `lib/user-text.ts`、安卓 `data/ImageNotes.kt`）——它们是独立
 * 构建/另一门语言，无法直接 import 本文件（与 choice-block 的三端复制同一约定）。
 *
 * pi 一共会追加 5 种注解（`utils/image-resize.ts`）：
 *   ① `[Image: original WxH, displayed at wxh. …]`  图片被缩放（大图必中）
 *   ② `[Image converted from <mime> to <mime>.]`   图片被转格式
 *   ③ `[Image omitted: could not be resized below the inline image size limit.]`
 *   ④ `[Image omitted: could not be converted to a supported inline image format.]`
 *   ⑤ `[Image omitted: configure an imageProcessor to convert BMP images.]`
 * ①② 是「图片已带上」的机器注解——**显示**就该剥掉；③④⑤ 是「图片没内联成功」的原因
 * 说明，剥了用户只会看到一个空气泡，所以**显示保留**。但它们都会让文本对账失配
 * （同一段正文在两端一个带注解一个不带），所以**对账时 5 种全剥**——两个函数各管一层。
 */

/** ① 图片被缩放的坐标注解（pi 用 `\n\n` 追加在用户正文之后，独占一行）。 */
const DIMENSION_NOTE_RE =
  /^[ \t]*\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\][ \t\r]*$/gm;
/** ② 图片被转格式的注解。 */
const CONVERTED_NOTE_RE = /^[ \t]*\[Image converted from [^\]]*\][ \t\r]*$/gm;
/** ③④⑤ 图片没能内联成功的原因说明（显示保留、对账剥掉）。 */
const OMITTED_NOTE_RE = /^[ \t]*\[Image omitted: [^\]]*\][ \t\r]*$/gm;

const DIMENSION_MARKER = "[Image: original ";
const CONVERTED_MARKER = "[Image converted from ";

/**
 * 剥掉「图片已带上」的机器注解（① 缩放坐标 / ② 转格式），并清掉留下的行尾空白。
 * 这是**显示用**的那个：`[Image omitted: …]` 故意保留（那是给用户看的原因说明）。
 *
 * 只认严格整行格式——用户自己写的方括号文本不会被误伤。
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
 * 各端把「乐观回显」转正时按文本相等比较，只要多一行注解就永远失配（气泡重复）。
 */
export function stripImageHints(text: string): string {
  // 注意标记里**不带空格**：缩放注解开头是 `[Image: original`（冒号），
  // 带空格的 `"[Image "` 匹配不到它（写成那样会让对账失去作用）。
  if (!text.includes("[Image")) return text;
  return stripImageDimensionNotes(text.replace(OMITTED_NOTE_RE, "")).replace(/[ \t\r\n]+$/, "");
}
