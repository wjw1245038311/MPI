package com.mpi.app

import com.mpi.app.data.Notifier
import org.junit.Assert.assertEquals
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
}
