package com.mpi.app

import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.ui.messageTextOf
import org.junit.Assert.assertEquals
import org.junit.Test

/** 批 2：消息复制取文本的口径（长按 / 复制按钮共用）。 */
class ThreadComposerLogicTest {

    @Test
    fun `copy text joins only text blocks`() {
        val message = ThreadMessage(
            id = "m1",
            role = "assistant",
            blocks = listOf(
                MessageBlock(type = BlockType.Text, text = "第一行"),
                MessageBlock(type = BlockType.Tool, name = "bash", text = "工具结果不该被复制"),
                MessageBlock(type = BlockType.Thinking, text = "思考"),
                MessageBlock(type = BlockType.Text, text = "第二行"),
            ),
        )
        assertEquals("第一行\n第二行", messageTextOf(message))
    }

    @Test
    fun `copy text of a tool-only message is empty`() {
        val message = ThreadMessage(
            id = "m2",
            role = "assistant",
            blocks = listOf(MessageBlock(type = BlockType.Tool, name = "read", text = "x")),
        )
        assertEquals("", messageTextOf(message))
    }
}
