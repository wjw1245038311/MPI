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

/** 工具调用显示/隐藏（本地设置）：只影响展示，不影响复制/choices 口径。 */
class ThreadVisibilityLogicTest {

    private fun assistant(vararg blocks: MessageBlock) = ThreadMessage(id = "m", role = "assistant", blocks = blocks.toList())

    @Test
    fun `showing tools returns the list untouched`() {
        val messages = listOf(assistant(MessageBlock(type = BlockType.Tool, name = "bash")))
        assertEquals(messages, com.mpi.app.ui.visibleMessages(messages, showToolCalls = true))
    }

    @Test
    fun `hiding tools drops tool blocks but keeps the rest`() {
        val messages = listOf(
            assistant(
                MessageBlock(type = BlockType.Thinking, text = "想一下"),
                MessageBlock(type = BlockType.Tool, name = "bash", text = "结果"),
                MessageBlock(type = BlockType.Text, text = "说完了"),
            ),
        )
        val visible = com.mpi.app.ui.visibleMessages(messages, showToolCalls = false)
        assertEquals(1, visible.size)
        assertEquals(listOf(BlockType.Thinking, BlockType.Text), visible.single().blocks.map { it.type })
    }

    @Test
    fun `a message with only tool blocks disappears entirely`() {
        val messages = listOf(
            assistant(MessageBlock(type = BlockType.Tool, name = "bash")),
            assistant(MessageBlock(type = BlockType.Text, text = "有正文")),
        )
        val visible = com.mpi.app.ui.visibleMessages(messages, showToolCalls = false)
        assertEquals(1, visible.size)
        assertEquals("有正文", visible.single().blocks.single().text)
    }
}

/** 主机把发送回退成「排队」时的提示口径（真机反馈：气泡永远停「发送中」）。 */
class QueuedSendNoteTest {

    private fun json(text: String) = com.mpi.app.protocol.Envelope.json.parseToJsonElement(text)

    @Test
    fun `queued as followUp produces a note`() {
        val note = com.mpi.app.ui.queuedNoteOf(json("""{"ok":true,"queuedAs":"followUp"}"""))
        assertEquals(true, note != null && note.contains("排队"))
    }

    @Test
    fun `a normal accept produces no note`() {
        assertEquals(null, com.mpi.app.ui.queuedNoteOf(json("""{"ok":true}""")))
        assertEquals(null, com.mpi.app.ui.queuedNoteOf(null))
    }

    @Test
    fun `an unknown queuedAs value is ignored`() {
        assertEquals(null, com.mpi.app.ui.queuedNoteOf(json("""{"queuedAs":"steer"}""")))
    }
}
