package com.mpi.app

import com.mpi.app.ui.Segment
import com.mpi.app.ui.parseSegments
import com.mpi.app.ui.splitInline
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M2-2：轻量 Markdown 切分（纯函数）。
 *
 * 之所以单独抽出来测：粗体曾因为一个「无反引号就提前 return」的写法静默失效，
 * 而截图里很难一眼看出来。切分逻辑不该靠肉眼验证。
 */
class MarkdownSegmentsTest {

    // ---- 块级：围栏代码 ----

    @Test
    fun `plain text is a single body segment`() {
        val segments = parseSegments("普通一段话")
        assertEquals(1, segments.size)
        assertEquals("普通一段话", (segments.single() as Segment.Body).text)
    }

    @Test
    fun `fenced code is separated from surrounding text`() {
        val segments = parseSegments("前\n```ts\nconst a = 1;\n```\n后")
        assertEquals(3, segments.size)
        assertEquals("前", (segments[0] as Segment.Body).text)
        assertEquals("const a = 1;", (segments[1] as Segment.Code).text)
        assertEquals("后", (segments[2] as Segment.Body).text)
    }

    @Test
    fun `an unclosed fence keeps its content instead of dropping it`() {
        // 流式过程中经常出现半截代码块 —— 内容绝不能消失
        val segments = parseSegments("看这段：\n```ts\nconst a = 1;")
        val all = segments.joinToString("") {
            when (it) {
                is Segment.Body -> it.text
                is Segment.Code -> it.text
                is Segment.Choice -> ""
            }
        }
        assertTrue("半截代码内容要保留", all.contains("const a = 1;"))
    }

    @Test
    fun `multiple code blocks are all kept`() {
        val segments = parseSegments("```\na\n```\n中间\n```\nb\n```")
        val codes = segments.filterIsInstance<Segment.Code>().map { it.text }
        assertEquals(listOf("a", "b"), codes)
    }

    // ---- 行内：代码与粗体 ----

    @Test
    fun `bold is recognized without any inline code present`() {
        // 这条正是曾经失效的场景
        val tokens = splitInline("定位到原因：**没有清理缓存**。")
        assertEquals(3, tokens.size)
        assertEquals("定位到原因：", tokens[0].text)
        assertEquals("没有清理缓存", tokens[1].text)
        assertTrue("应标记为粗体", tokens[1].bold)
        assertEquals("。", tokens[2].text)
    }

    @Test
    fun `inline code is marked and not treated as bold`() {
        val tokens = splitInline("用 `**not bold**` 试试")
        val code = tokens.single { it.code }
        assertEquals("**not bold**", code.text)
        assertTrue("代码段内的星号不应被当粗体", code.bold.not())
    }

    @Test
    fun `bold and inline code coexist`() {
        val tokens = splitInline("**注意**：改 `src/a.ts`")
        assertTrue(tokens.any { it.bold && it.text == "注意" })
        assertTrue(tokens.any { it.code && it.text == "src/a.ts" })
    }

    @Test
    fun `unpaired markers are kept as literal text`() {
        val tokens = splitInline("一个星号 * 和半个反引号 `")
        val text = tokens.joinToString("") { it.text }
        assertTrue("文本内容不能因为未配对标记而丢失", text.contains("一个星号"))
        assertTrue(tokens.none { it.bold })
    }
}
