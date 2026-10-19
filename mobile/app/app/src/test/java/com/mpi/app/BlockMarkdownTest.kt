package com.mpi.app

import com.mpi.app.ui.MdBlock
import com.mpi.app.ui.MdListItem
import com.mpi.app.ui.parseBlocks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 块级 markdown（2026-10-19）：标题 / 列表（含嵌套）/ 引用 / GFM 表格 / 段落。
 * 与 PWA 的 lib/block-md.ts 同构。
 */
class BlockMarkdownTest {

    @Test
    fun `headings keep their level`() {
        assertEquals(listOf(MdBlock.Heading(2, "三件需要你定的事")), parseBlocks("## 三件需要你定的事"))
        assertEquals(3, (parseBlocks("### 深一层").single() as MdBlock.Heading).level)
    }

    @Test
    fun `unordered list merges consecutive items`() {
        val blocks = parseBlocks("- A\n- B\n* C\n+ D")
        assertEquals(
            listOf(MdBlock.Bullets(listOf(MdListItem("A"), MdListItem("B"), MdListItem("C"), MdListItem("D")))),
            blocks,
        )
    }

    @Test
    fun `nested list uses indentation depth`() {
        val blocks = parseBlocks("- 顶层\n  - 子项\n    - 孙项")
        val items = (blocks.single() as MdBlock.Bullets).items
        assertEquals(listOf(0, 1, 2), items.map { it.depth })
        assertEquals(listOf("顶层", "子项", "孙项"), items.map { it.text })
    }

    @Test
    fun `ordered list keeps its start number`() {
        assertEquals(
            listOf(MdBlock.Ordered(listOf(MdListItem("甲"), MdListItem("乙")), 1)),
            parseBlocks("1. 甲\n2. 乙"),
        )
        assertEquals(
            listOf(MdBlock.Ordered(listOf(MdListItem("丙"), MdListItem("丁")), 3)),
            parseBlocks("3) 丙\n4) 丁"),
        )
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
        val items = (blocks.single() as MdBlock.Bullets).items
        assertEquals(listOf("第一项\n继续说明", "第二项"), items.map { it.text })
    }

    @Test
    fun `quote lines merge`() {
        assertEquals(listOf(MdBlock.Quote("引用一句\n第二行")), parseBlocks("> 引用一句\n> 第二行"))
    }

    @Test
    fun `gfm table parses header align and rows`() {
        val table = parseBlocks("| 名称 | 值 |\n|:---|---:|\n| A | 1 |\n| B | 2 |").single() as MdBlock.Table
        assertEquals(listOf("名称", "值"), table.header)
        assertEquals(listOf("left", "right"), table.align)
        assertEquals(listOf(listOf("A", "1"), listOf("B", "2")), table.rows)
    }

    @Test
    fun `escaped pipe stays inside the cell`() {
        val table = parseBlocks("| a |\n|---|\n| x \\| y |").single() as MdBlock.Table
        assertEquals(listOf(listOf("x | y")), table.rows)
    }

    @Test
    fun `plain text and empty input are safe`() {
        assertEquals(emptyList<MdBlock>(), parseBlocks(""))
        assertEquals("就是一句话", (parseBlocks("就是一句话").single() as MdBlock.Para).text)
        assertEquals("第一行\n第二行", (parseBlocks("第一行\n第二行").single() as MdBlock.Para).text)
        assertTrue(parseBlocks("**重点**").single() is MdBlock.Para)
    }
}
