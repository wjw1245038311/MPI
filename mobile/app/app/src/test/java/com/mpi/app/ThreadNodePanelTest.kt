package com.mpi.app

import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.ui.userMessageNodes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 会话节点面板：节点提取（纯函数）。 */
class ThreadNodePanelTest {

    private fun message(
        id: String,
        role: String,
        text: String,
        pending: Boolean = false,
    ) = ThreadMessage(
        id = id,
        role = role,
        pending = pending,
        blocks = listOf(MessageBlock(type = BlockType.Text, text = text)),
    )

    @Test
    fun `nodes are the user messages, with their index in the rendered list`() {
        val display = listOf(
            message("u1", "user", "第一条 问题"),
            message("a1", "assistant", "回答"),
            message("u2", "user", "第二条\n问题"),
            message("a2", "assistant", "回答二"),
        )
        val nodes = userMessageNodes(display)
        assertEquals(2, nodes.size)
        assertEquals("u1", nodes[0].id)
        assertEquals(0, nodes[0].index)
        assertEquals("第一条 问题", nodes[0].preview)
        assertEquals("u2", nodes[1].id)
        // 索引是「在传入列表里的下标」——跳转要能用它直接 animateScrollToItem
        assertEquals(2, nodes[1].index)
        // 换行要压平（面板一行放不下多行预览）
        assertEquals("第二条 问题", nodes[1].preview)
    }

    @Test
    fun `optimistic pending user messages are skipped`() {
        // 乐观回显还没落到主机，跳过去没有意义
        assertEquals(0, userMessageNodes(listOf(message("u1", "user", "还没发出去", pending = true))).size)
    }

    @Test
    fun `empty text falls back to an attachment label and long text is clipped`() {
        val nodes = userMessageNodes(
            listOf(
                message("u1", "user", ""),
                message("u2", "user", "x".repeat(200)),
            ),
        )
        assertEquals("（图片/附件）", nodes[0].preview)
        assertEquals(60, nodes[1].preview.length)
        assertTrue(nodes[1].preview.endsWith("x"))
    }

    @Test
    fun `an all assistant thread has no nodes`() {
        assertEquals(0, userMessageNodes(listOf(message("a1", "assistant", "只有回答"))).size)
    }
}
