package com.mpi.app.data

/**
 * 用户消息里的机器注解清理（桌面端 `src/shared/image-notes.ts` / PWA `lib/user-text.ts` 的移植）。
 *
 * pi 处理图片附件时会把机器注解追加到用户正文末尾（`utils/image-resize.ts`）：
 *
 *     [Image: original 2548x402, displayed at 2000x316. Multiply coordinates by 1.27
 *      to map to original image.]                 ← 图片被缩放（大图必中）
 *     [Image converted from image/heic to image/png.]  ← 图片被转格式
 *     [Image omitted: …]                          ← 图片没能内联成功（附原因）
 *
 * 只在前两种情况下图片是「带上了」的（大图必中，所以「发带图的话」经常命中）。
 * 两个后果：
 *  1. 气泡里露出这行不是用户写的英文文本；
 *  2. [ThreadSession.handleMessageStart] 把乐观回显「转正」时按**文本相等**对账，
 *     多出注解就永远失配 → 同一条消息上屏两次。
 *
 * 快照里的文本已由主机剥过（main/ipc.ts 的 remote 构建），但**实时事件通道**是
 * 原样转发 pi 事件的，所以客户端必须自己再剥一次。
 *
 * 两个函数各管一层（三端规则一致）：
 *  - [stripImageDimensionNotes]：**显示**用——`[Image omitted: …]` 保留（那是给用户看的原因说明）
 *  - [stripImageHints]：**对账**用——5 种注解全剥（差一行就配不上）
 */

/** ① 图片被缩放的坐标注解。 */
private val DIMENSION_NOTE_RE = Regex(
    """^[ \t]*\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\][ \t\r]*$""",
    RegexOption.MULTILINE,
)

/** ② 图片被转格式的注解。 */
private val CONVERTED_NOTE_RE = Regex(
    """^[ \t]*\[Image converted from [^\]]*\][ \t\r]*$""",
    RegexOption.MULTILINE,
)

/** ③④⑤ 图片没能内联成功的原因说明（显示保留、对账剥掉）。 */
private val OMITTED_NOTE_RE = Regex(
    """^[ \t]*\[Image omitted: [^\]]*\][ \t\r]*$""",
    RegexOption.MULTILINE,
)

private const val DIMENSION_MARKER = "[Image: original "
private const val CONVERTED_MARKER = "[Image converted from "
private const val ANY_HINT_MARKER = "[Image" // 不带空格：`[Image: original` 是冒号开头

/** 剥掉「图片已带上」的机器注解（① 缩放 / ② 转格式），并清掉留下的行尾空白 —— **显示用**。 */
internal fun stripImageDimensionNotes(text: String): String {
    if (!text.contains(DIMENSION_MARKER) && !text.contains(CONVERTED_MARKER)) return text
    return DIMENSION_NOTE_RE.replace(CONVERTED_NOTE_RE.replace(text, ""), "").trimEnd()
}

/** 剥掉 **全部** 图片注解（含「图片没能内联」的原因说明）——**对账用**。 */
internal fun stripImageHints(text: String): String {
    if (!text.contains(ANY_HINT_MARKER)) return text
    return stripImageDimensionNotes(OMITTED_NOTE_RE.replace(text, "")).trimEnd()
}
