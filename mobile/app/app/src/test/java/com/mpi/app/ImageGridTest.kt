package com.mpi.app

import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.ui.IMAGE_GRID_MAX
import com.mpi.app.ui.MessageItem
import com.mpi.app.ui.buildImageGrid
import com.mpi.app.ui.groupImageBlocks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 多图九宫格（2026-11-06，与网页版同规则）：分组 + 「+N」计算。 */
class ImageGridTest {

    private fun image(id: String) = MessageBlock(type = BlockType.Image, data = "b64-$id")
    private fun text(value: String) = MessageBlock(type = BlockType.Text, text = value)
    private fun tool(id: String) = MessageBlock(type = BlockType.Tool, id = id, name = "bash")

    @Test
    fun `single image is not a grid`() {
        assertNull(buildImageGrid(listOf(image("1"))))
        assertNull(buildImageGrid(emptyList()))
    }

    @Test
    fun `column count and plus-N follow the count`() {
        assertEquals(2, buildImageGrid(listOf(image("1"), image("2")))!!.cols)
        assertEquals(2, buildImageGrid(List(4) { image("$it") })!!.cols)
        assertEquals(3, buildImageGrid(List(5) { image("$it") })!!.cols)

        val nine = buildImageGrid(List(9) { image("$it") })!!
        assertEquals(3, nine.cols)
        assertEquals(9, nine.visible.size)
        assertEquals(0, nine.hidden)

        val ten = buildImageGrid(List(10) { image("$it") })!!
        assertEquals(IMAGE_GRID_MAX - 1, ten.visible.size)
        assertTrue("10 张：前 8 张占格子，第 9 格是 +2", ten.hidden == 2)
    }

    @Test
    fun `only consecutive images merge`() {
        val items = groupImageBlocks(
            listOf(text("说明"), image("1"), image("2"), tool("t1"), image("3"), text("结尾")),
        )
        assertEquals(5, items.size)
        assertTrue(items[0] is MessageItem.Single)
        assertTrue("连续两张要成网格", items[1] is MessageItem.ImageGrid)
        assertEquals(2, (items[1] as MessageItem.ImageGrid).blocks.size)
        assertTrue("工具行打断聚合", items[2] is MessageItem.Single)
        assertTrue("单张仍是普通块", items[3] is MessageItem.Single)
        assertTrue(items[4] is MessageItem.Single)
    }

    @Test
    fun `a message with only images becomes one grid`() {
        val items = groupImageBlocks(List(3) { image("$it") })
        assertEquals(1, items.size)
        assertEquals(3, (items[0] as MessageItem.ImageGrid).blocks.size)
    }
}
