package com.mpi.app

import com.mpi.app.ui.TurnSpeechLogic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「回合完成要不要出声念」的判定表。
 *
 * 两次真机教训（见 `TurnSpeechLogic` 顶部）：
 * 1. 2026-10-30 前只念「手机发起 + 当前打开」的回合 → 锁屏、划走、电脑发起的全静默；
 * 2. 2026-11 第一次修时顺手沿用了通知的「正在看就跳过」口径 → **前台看着也不念了**。
 * 用户口径很明确：**只要开着播报，跑完就念**。这里把这条钉住，防止再被「优化」掉。
 */
class TurnSpeechLogicTest {

    private fun decide(
        enabled: Boolean = true,
        voiceChatActive: Boolean = false,
        inCall: Boolean = false,
        allowDuringCall: Boolean = false,
    ) = TurnSpeechLogic.decide(enabled, voiceChatActive, inCall, allowDuringCall)

    @Test
    fun `前台打开着会话、跑完就念（2026-11 回归点：不能被「正在看」跳过）`() {
        // 判定里根本没有「watching」这个入参——这条测试同时钉住「别再把它加回来」。
        val d = decide()
        assertTrue(d.speak)
        assertEquals("已播报", d.reason)
    }

    @Test
    fun `语音对话模式开着：不念（那套循环自己会念，避免念两遍）`() {
        val d = decide(voiceChatActive = true)
        assertFalse(d.speak)
        assertEquals("跳过：语音对话模式自己会念", d.reason)
    }

    @Test
    fun `设置里关了语音播报：不念，理由要说清是设置`() {
        val d = decide(enabled = false)
        assertFalse(d.speak)
        assertEquals("跳过：设置里已关闭语音播报", d.reason)
    }

    @Test
    fun `通话中默认跳过`() {
        val d = decide(inCall = true)
        assertFalse(d.speak)
        assertEquals("跳过：通话中（未允许通话中播报）", d.reason)
    }

    @Test
    fun `开了通话中也播报：照念，但理由里注明可能听不到`() {
        val d = decide(inCall = true, allowDuringCall = true)
        assertTrue(d.speak)
        assertEquals("已播报（通话中，可能听不到）", d.reason)
    }

    @Test
    fun `优先级：设置关掉时盖过一切其它理由`() {
        val d = decide(enabled = false, voiceChatActive = true, inCall = true)
        assertFalse(d.speak)
        assertEquals("跳过：设置里已关闭语音播报", d.reason)
    }

    @Test
    fun `优先级：语音模式盖过通话中`() {
        val d = decide(voiceChatActive = true, inCall = true)
        assertFalse(d.speak)
        assertEquals("跳过：语音对话模式自己会念", d.reason)
    }
}
