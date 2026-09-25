package com.mpi.app

import com.mpi.app.data.Notifier
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
    fun `only phone initiated turns notify, and only while backgrounded`() {
        assertTrue(Notifier.shouldNotifyTurnComplete(enabled = true, foreground = false, phoneInitiated = true))
        // 设置关掉 → 不发
        assertTrue(!Notifier.shouldNotifyTurnComplete(enabled = false, foreground = false, phoneInitiated = true))
        // 在前台盯着屏幕 → 不打扰
        assertTrue(!Notifier.shouldNotifyTurnComplete(enabled = true, foreground = true, phoneInitiated = true))
        // 桌面发起的回合 → 不响
        assertTrue(!Notifier.shouldNotifyTurnComplete(enabled = true, foreground = false, phoneInitiated = false))
    }
}
