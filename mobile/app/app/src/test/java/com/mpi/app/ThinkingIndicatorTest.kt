package com.mpi.app

import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.protocol.UiRequest
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
        pendingUi: UiRequest? = null,
    ) = ThreadView(
        threadId = "t",
        running = running,
        streaming = streaming,
        compacting = compacting,
        messages = messages,
        pendingUi = pendingUi,
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
    fun `hidden once there is something visible to show`() {
        // 已有正文 → 消息自己渲染，不需要占位行
        assertFalse(
            shouldShowThinkingPlaceholder(
                view(streaming = ThreadMessage(id = "s", role = "assistant", blocks = listOf(MessageBlock(type = BlockType.Text, text = "好")))),
            ),
        )
        assertFalse(shouldShowThinkingPlaceholder(view(running = false)))
    }

    @Test
    fun `shown while the assistant message has started but has no content yet`() {
        // 本地模型的真实状态：pi 在 HTTP 响应头到达时就发了 message_start，而 prefill
        // 还没结束——streaming 非空、一个块都没有。
        assertTrue(shouldShowThinkingPlaceholder(view(streaming = ThreadMessage(id = "s", role = "assistant"))))
        assertTrue(
            shouldShowThinkingPlaceholder(
                view(streaming = ThreadMessage(id = "s", role = "assistant", blocks = listOf(MessageBlock(type = BlockType.Text, text = "")))),
            ),
        )
    }

    @Test
    fun `hidden while compacting`() {
        assertFalse(shouldShowThinkingPlaceholder(view(compacting = true)))
    }

    @Test
    fun `hidden while an approval card is waiting for the user`() {
        // 2026-11-05 真机：「明明不是思考却显示思考中」——当时屏上正挂着一张权限确认卡。
        // 挂着卡 = agent 在等人，不是在跑模型；三端同一判据。
        val card = UiRequest(id = "ui-1", method = "confirm", title = "权限确认")
        assertFalse(shouldShowThinkingPlaceholder(view(pendingUi = card)))
        assertFalse(shouldShowThinkingPlaceholder(view(streaming = ThreadMessage(id = "s", role = "assistant"), pendingUi = card)))
        // 没卡时旧行为不变
        assertTrue(shouldShowThinkingPlaceholder(view(pendingUi = null)))
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
