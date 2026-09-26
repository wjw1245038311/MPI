package com.mpi.app

import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.ui.formatElapsed
import com.mpi.app.ui.shouldShowThinkingPlaceholder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Prefill 等待指示器（与桌面端 `lib/thinking-indicator.ts` 同一套语义）。
 *
 * 覆盖「什么时候显示」与「秒数怎么写」两件纯逻辑；计时器本身在 Compose 里，不在此测。
 */
class ThinkingIndicatorTest {

    private fun view(
        running: Boolean = true,
        streaming: ThreadMessage? = null,
        compacting: Boolean = false,
        messages: List<ThreadMessage> = emptyList(),
    ) = ThreadView(
        threadId = "t",
        running = running,
        streaming = streaming,
        compacting = compacting,
        messages = messages,
    )

    private fun assistant(id: String, running: Boolean) = ThreadMessage(
        id = id,
        role = "assistant",
        blocks = listOf(MessageBlock(type = BlockType.Tool, name = "bash", running = running)),
    )

    @Test
    fun `shows while waiting for the first token`() {
        assertTrue(shouldShowThinkingPlaceholder(view()))
    }

    @Test
    fun `hidden once the assistant message starts or the run ends`() {
        assertFalse(shouldShowThinkingPlaceholder(view(streaming = ThreadMessage(id = "s", role = "assistant"))))
        assertFalse(shouldShowThinkingPlaceholder(view(running = false)))
    }

    @Test
    fun `hidden while compacting`() {
        assertFalse(shouldShowThinkingPlaceholder(view(compacting = true)))
    }

    @Test
    fun `hidden while a tool is running, shown again after it finishes`() {
        assertFalse(shouldShowThinkingPlaceholder(view(messages = listOf(assistant("m1", running = true)))))

        // 工具跑完 → 等下一轮 prefill，占位行回来
        assertTrue(shouldShowThinkingPlaceholder(view(messages = listOf(assistant("m1", running = false)))))
    }

    @Test
    fun `elapsed formatting switches to minutes past one minute`() {
        assertEquals("0s", formatElapsed(0))
        assertEquals("59s", formatElapsed(59))
        assertEquals("1m00s", formatElapsed(60))
        assertEquals("1m23s", formatElapsed(83))
        assertEquals("59m59s", formatElapsed(3599))
        assertEquals("0s", formatElapsed(-5)) // 时钟回拨不吐怪字符串
    }
}
