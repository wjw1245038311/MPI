package com.mpi.app

import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.ui.looksAwaitingReply
import com.mpi.app.ui.shouldShowAwaitingReply
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「等你回复」提示（纯函数）。与桌面 `lib/awaiting-reply.ts`、PWA 同名文件同一判据，
 * 三端一致性由 `scripts/test-awaiting-reply.mjs` 的 parity 断言守护。
 *
 * 现场：minibox 会话 `session-01a1885c`（2026-10-30 00:27）模型以正文提问收尾，
 * 会话文件干净（stopReason=stop），界面却与「任务做完」一模一样。
 */
class AwaitingReplyLogicTest {

    // ---- looksAwaitingReply ----------------------------------------------------

    @Test
    fun `现场原句：正文提问收尾要提示`() {
        assertTrue(
            looksAwaitingReply(
                "…其中一条是新的 ready 决定（愚人节 → 目标），我没有 apply 它，等你对第 4 条的意见。",
            ),
        )
    }

    @Test
    fun `收尾问句要提示`() {
        assertTrue(looksAwaitingReply("这一批做完了，要不要现在就发版？"))
        assertTrue(looksAwaitingReply("Should I go ahead with option B?"))
        // 尾部装饰符（引号 / 括号 / 空格）不影响判定
        assertTrue(looksAwaitingReply("要现在推吗？（等你确认）"))
        assertTrue(looksAwaitingReply("下一步走 A 还是 B？ "))
    }

    @Test
    fun `明确等待语要提示`() {
        assertTrue(looksAwaitingReply("改动已提交，待你确认后我推送。"))
        assertTrue(looksAwaitingReply("Everything is committed. Let me know if you want the push."))
    }

    @Test
    fun `正常汇报不提示`() {
        assertFalse(looksAwaitingReply("已完成，测试 130 pass，已推送 origin/main。"))
        assertFalse(looksAwaitingReply(""))
        // 以代码块 / 表格收尾，且没有等待语
        assertFalse(looksAwaitingReply("改完了：\n```ts\nconst a = 1;\n```"))
        assertFalse(looksAwaitingReply("| 项 | 结果 |\n|---|---|\n| 测试 | 通过 |"))
    }

    @Test
    fun `已经给了可点面板不再叠加`() {
        assertFalse(
            looksAwaitingReply("结论如下。\n```choices\n[{\"title\":\"下一步\",\"options\":[\"A\",\"B\"]}]\n```"),
        )
    }

    @Test
    fun `等待语只出现在长文开头不算`() {
        val long = "等你先看这段背景，后面全是本次的错误码与日志。\n" + "x".repeat(600)
        assertFalse(looksAwaitingReply(long))
    }

    // ---- shouldShowAwaitingReply（回合状态）------------------------------------

    private fun view(
        messages: List<ThreadMessage> = emptyList(),
        running: Boolean = false,
        streaming: ThreadMessage? = null,
        errorBanner: String? = null,
        compacting: Boolean = false,
    ) = ThreadView(
        threadId = "t",
        messages = messages,
        running = running,
        streaming = streaming,
        errorBanner = errorBanner,
        compacting = compacting,
    )

    private fun assistant(text: String) = ThreadMessage(
        id = "a1",
        role = "assistant",
        blocks = listOf(MessageBlock(type = BlockType.Text, text = text)),
    )

    @Test
    fun `回合已停且末条是提问 → 显示`() {
        assertTrue(shouldShowAwaitingReply(view(messages = listOf(assistant("要现在发版吗？")))))
    }

    @Test
    fun `回合还在跑 → 不显示`() {
        assertFalse(shouldShowAwaitingReply(view(messages = listOf(assistant("要现在发版吗？")), running = true)))
    }

    @Test
    fun `还有流式消息 → 不显示`() {
        val streaming = ThreadMessage(id = "a2", role = "assistant", blocks = emptyList())
        assertFalse(
            shouldShowAwaitingReply(
                view(messages = listOf(assistant("要现在发版吗？")), streaming = streaming),
            ),
        )
    }

    @Test
    fun `有错误横幅或压缩中 → 不显示`() {
        assertFalse(shouldShowAwaitingReply(view(messages = listOf(assistant("要现在发版吗？")), errorBanner = "出错了")))
        assertFalse(shouldShowAwaitingReply(view(messages = listOf(assistant("要现在发版吗？")), compacting = true)))
    }

    @Test
    fun `末条是用户消息 → 不显示`() {
        val user = ThreadMessage(id = "u1", role = "user", blocks = listOf(MessageBlock(type = BlockType.Text, text = "要现在发版吗？")))
        assertFalse(shouldShowAwaitingReply(view(messages = listOf(assistant("做完了。"), user))))
    }

    @Test
    fun `没有消息 → 不显示`() {
        assertFalse(shouldShowAwaitingReply(view()))
    }
}
