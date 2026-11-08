package com.mpi.app

import com.mpi.app.ui.TurnSpeechLogic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「回合完成要不要出声念」的判定表。
 *
 * 现场（2026-11，真机）：锁屏后完全没声音，回前台打开 App 才补提示，回合其实早就跑完了。
 * 直接原因是电池优化没豁免（Doze 掐网络，另案已修文案）；但**即使网络正常**，播报当时也
 * 挂着「只在当前打开会话 + 只念手机发起」两把锁——锁屏场景照样一声不出，而通知照发。
 * 这里把新口径（与通知同源）钉住。
 */
class TurnSpeechLogicTest {

    private fun decide(
        enabled: Boolean = true,
        voiceChatActive: Boolean = false,
        watchingThread: Boolean = false,
        inCall: Boolean = false,
        allowDuringCall: Boolean = false,
    ) = TurnSpeechLogic.decide(enabled, voiceChatActive, watchingThread, inCall, allowDuringCall)

    @Test
    fun `锁屏没看着这个会话：要念（本次修复的核心场景）`() {
        val d = decide(watchingThread = false)
        assertTrue(d.speak)
        assertEquals("已播报", d.reason)
    }

    @Test
    fun `前台但正在看这条会话：不念`() {
        val d = decide(watchingThread = true)
        assertFalse(d.speak)
        assertEquals("跳过：正在看这个会话", d.reason)
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
        // 同时满足「语音模式开 + 通话中 + 正在看」——理由应该只报最外层的那条。
        val d = decide(enabled = false, voiceChatActive = true, watchingThread = true, inCall = true)
        assertFalse(d.speak)
        assertEquals("跳过：设置里已关闭语音播报", d.reason)
    }

    @Test
    fun `优先级：语音模式盖过正在看与通话`() {
        val d = decide(voiceChatActive = true, watchingThread = true, inCall = true)
        assertFalse(d.speak)
        assertEquals("跳过：语音对话模式自己会念", d.reason)
    }
}
