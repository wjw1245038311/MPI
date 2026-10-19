package com.mpi.app

import com.mpi.app.ui.MdBlock
import com.mpi.app.ui.parseBlocks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 块级 markdown（2026-10-19：手机端 `## 标题`、`- 列表项` 是原样字符，桌面是真标题/列表）。
 *
 * 与 PWA 的 lib/block-md.ts 同构：标题 1-6 级、无序列表（-、*、+）、有序列表（1. / 1)）、
 * 引用（>）、段落；其余一律当段落，保留换行。
 */
class BlockMarkdownTest {

    @Test
    fun `headings keep their level`() {
        val blocks = parseBlocks("## 三件需要你定的事")
        assertEquals(listOf(MdBlock.Heading(2, "三件需要你定的事")), blocks)
        assertEquals(3, (parseBlocks("### 深一层").single() as MdBlock.Heading).level)
    }

    @Test
    fun `unordered list merges consecutive items`() {
        val blocks = parseBlocks("- A\n- B\n* C\n+ D")
        assertEquals(listOf(MdBlock.Bullets(listOf("A", "B", "C", "D"))), blocks)
    }

    @Test
    fun `ordered list keeps its start number`() {
        assertEquals(listOf(MdBlock.Ordered(listOf("甲", "乙"), 1)), parseBlocks("1. 甲\n2. 乙"))
        assertEquals(listOf(MdBlock.Ordered(listOf("丙", "丁"), 3)), parseBlocks("3) 丙\n4) 丁"))
    }

    @Test
    fun `paragraph and list interleave`() {
        val blocks = parseBlocks("先说明一句：\n\n- 要点一\n- 要点二\n\n最后总结。")
        assertEquals(listOf("Para", "Bullets", "Para"), blocks.map { it::class.simpleName })
        assertEquals("先说明一句：", (blocks.first() as MdBlock.Para).text)
        assertEquals("最后总结。", (blocks.last() as MdBlock.Para).text)
    }

    @Test
    fun `indented continuation joins the previous item`() {
        val blocks = parseBlocks("- 第一项\n  继续说明\n- 第二项")
        assertEquals(listOf("第一项\n继续说明", "第二项"), (blocks.single() as MdBlock.Bullets).items)
    }

    @Test
    fun `quote lines merge`() {
        assertEquals(listOf(MdBlock.Quote("引用一句\n第二行")), parseBlocks("> 引用一句\n> 第二行"))
    }

    @Test
    fun `plain text and empty input are safe`() {
        assertEquals(emptyList<MdBlock>(), parseBlocks(""))
        assertEquals("就是一句话", (parseBlocks("就是一句话").single() as MdBlock.Para).text)
        assertEquals("第一行\n第二行", (parseBlocks("第一行\n第二行").single() as MdBlock.Para).text)
    }

    @Test
    fun `inline bold on its own line is not a list`() {
        val blocks = parseBlocks("**重点**")
        assertTrue(blocks.single() is MdBlock.Para)
    }
}
