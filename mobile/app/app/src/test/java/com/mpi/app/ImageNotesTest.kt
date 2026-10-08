package com.mpi.app

import com.mpi.app.data.stripImageDimensionNotes
import com.mpi.app.data.stripImageHints
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * pi 图片注解清理（安卓侧，与桌面 `scripts/test-image-notes.mjs` 同一组用例）。
 *
 * 这段注解只在图片被缩放过时出现（大图必中），既会露在气泡里，又会让
 * `message_start` 的「乐观回显转正」文本对账失配 → 同一条消息上屏两次。
 */
class ImageNotesTest {

    private val note =
        "[Image: original 2548x402, displayed at 2000x316. Multiply coordinates by 1.27 to map to original image.]"

    private fun withNote(text: String) = "$text\n\n$note"

    @Test
    fun `annotation after the prompt is stripped`() {
        assertEquals("帮我看看这个", stripImageDimensionNotes(withNote("帮我看看这个")))
    }

    @Test
    fun `stripping is idempotent`() {
        val once = stripImageDimensionNotes(withNote("x"))
        assertEquals("x", stripImageDimensionNotes(once))
    }

    @Test
    fun `plain text is returned untouched`() {
        assertEquals("  纯文本\n\n第二段  ", stripImageDimensionNotes("  纯文本\n\n第二段  "))
    }

    @Test
    fun `annotation in the middle is stripped too`() {
        assertEquals("第一段\n\n第二段", stripImageDimensionNotes("第一段\n$note\n第二段"))
    }

    @Test
    fun `crlf line endings are handled`() {
        assertEquals("正文", stripImageDimensionNotes("正文\r\n\r\n$note\r\n"))
    }

    @Test
    fun `annotation-only message becomes empty`() {
        assertEquals("", stripImageDimensionNotes(note))
    }

    @Test
    fun `user written bracket text is untouched`() {
        val mine = "[Image: 我自己的说明] 和 [Image: original 100x100]"
        assertEquals(mine, stripImageDimensionNotes(mine))
    }

    @Test
    fun `omitted image notice is kept on purpose`() {
        val omitted = "[Image omitted: could not be resized below the inline image size limit.]"
        assertEquals(omitted, stripImageDimensionNotes(omitted))
    }

    @Test
    fun `converted image notice is stripped for display`() {
        assertEquals("看这个", stripImageDimensionNotes(withNote("看这个").replace(note, "[Image converted from image/heic to image/png.]")))
    }

    @Test
    fun `compare stripping removes every hint kind`() {
        // 对账必须把这 5 种全剥（差一行就配不上 → 气泡重复）
        val cases = listOf(
            note,
            "[Image converted from image/heic to image/png.]",
            "[Image omitted: could not be resized below the inline image size limit.]",
            "[Image omitted: could not be converted to a supported inline image format.]",
            "[Image omitted: configure an imageProcessor to convert BMP images.]",
        )
        for (hint in cases) assertEquals("带图的问题", stripImageHints(withNote("带图的问题").replace(note, hint)))
        // 没有注解时原样（不动内容）
        assertEquals("普通文本", stripImageHints("普通文本"))
    }
}
