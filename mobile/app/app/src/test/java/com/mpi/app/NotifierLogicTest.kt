package com.mpi.app

import com.mpi.app.data.Notifier
import com.mpi.app.data.VoiceSpeechContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** M5：审批通知的文案（纯函数）。 */
class NotifierLogicTest {

    @Test
    fun `approval text carries the thread title`() {
        assertEquals("「修复登录 bug」正在等待批准", Notifier.approvalText("修复登录 bug"))
    }

    @Test
    fun `blank or missing title falls back to a generic line`() {
        assertEquals("有会话正在等待批准", Notifier.approvalText(null))
        assertEquals("有会话正在等待批准", Notifier.approvalText("   "))
    }

    @Test
    fun `long titles are truncated to keep the notification readable`() {
        val long = "x".repeat(100)
        assertEquals("「${"x".repeat(40)}」正在等待批准", Notifier.approvalText(long))
    }

    @Test
    fun `turn complete title carries the thread title`() {
        assertEquals("「修复登录 bug」回复已完成", Notifier.turnCompleteTitle("修复登录 bug"))
        assertEquals("MPI 回复已完成", Notifier.turnCompleteTitle(null))
        assertEquals("MPI 回复已完成", Notifier.turnCompleteTitle("   "))
    }

    @Test
    fun `turn complete text flattens the reply and falls back when empty`() {
        assertEquals("已经改好了。", Notifier.turnCompleteText("已经改好了。"))
        assertEquals("a b c", Notifier.turnCompleteText("a\n\nb\tc "))
        assertEquals("回复已完成", Notifier.turnCompleteText(null))
        assertEquals("回复已完成", Notifier.turnCompleteText("   "))
    }

    @Test
    fun `turn complete text reports the failure first`() {
        // 失败比回复更需要知道：两者都在时以错误为准
        assertEquals("出错：进程已退出（code 1）", Notifier.turnCompleteText("旧回复", "进程已退出（code 1）"))
        assertEquals("出错：进程已退出（code 1）", Notifier.turnCompleteText(null, " 进程已退出（code 1） "))
    }

    @Test
    fun `long turn complete text is truncated`() {
        assertEquals("${"x".repeat(79)}…", Notifier.turnCompleteText("x".repeat(100)))
    }

    @Test
    fun `speech fixed content is short and never reads the reply`() {
        assertEquals(
            "「修复登录 bug」 回复已完成",
            Notifier.turnCompleteSpeech(VoiceSpeechContent.Fixed, "修复登录 bug", "一大段回复正文"),
        )
        assertEquals("回复已完成", Notifier.turnCompleteSpeech(VoiceSpeechContent.Fixed, null, null))
    }

    @Test
    fun `speech reply content drops code fences and the long one is clipped`() {
        val reply = "已经改好了：\n```kotlin\nval x = 1\n```\n下次不会再这样。"
        assertEquals(
            "「部署」 已经改好了： 下次不会再这样。",
            Notifier.turnCompleteSpeech(VoiceSpeechContent.Reply, "部署", reply),
        )
        val spoken = Notifier.turnCompleteSpeech(VoiceSpeechContent.Reply, null, "字".repeat(100))
        assertEquals(60, spoken.length)
        assertTrue(spoken.endsWith("…"))
    }

    @Test
    fun `speech falls back to the fixed line when nothing is left to read`() {
        assertEquals("回复已完成", Notifier.turnCompleteSpeech(VoiceSpeechContent.Reply, null, "   "))
        assertEquals("回复已完成", Notifier.turnCompleteSpeech(VoiceSpeechContent.Reply, null, null))
        // 只有代码：去掉围栏后什么都不剩 → 退回固定语
        assertEquals("回复已完成", Notifier.turnCompleteSpeech(VoiceSpeechContent.Reply, null, "```js\ncode()\n```"))
    }

    @Test
    fun `a finished turn notifies unless the user is watching that thread`() {
        // 飞书已读口径：不区分谁发起，只要没在看着这个会话就通知
        assertTrue(Notifier.shouldNotifyTurnComplete(enabled = true, watchingThread = false))
        // 设置关掉 → 不发
        assertTrue(!Notifier.shouldNotifyTurnComplete(enabled = false, watchingThread = false))
        // 正在看这个会话 → 不打扰
        assertTrue(!Notifier.shouldNotifyTurnComplete(enabled = true, watchingThread = true))
    }
}
