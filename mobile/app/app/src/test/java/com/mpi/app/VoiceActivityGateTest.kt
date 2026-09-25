package com.mpi.app

import com.mpi.app.data.VoiceActivityGate
import com.mpi.app.data.VoiceGateDecision
import com.mpi.app.data.pcm16Rms
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 语音对话模式阶段 1：静音判定（纯函数）与音量计算。 */
class VoiceActivityGateTest {

    @Test
    fun `rms is zero for silence and high for a loud tone`() {
        val silence = ByteArray(800)
        assertEquals(0.0, pcm16Rms(silence, 0, silence.size), 0.0001)

        val loud = ByteArray(800)
        for (i in 0 until 400) {
            loud[i * 2] = 0x00
            loud[i * 2 + 1] = 0x40 // 0x4000 = 16384 ≈ 0.5
        }
        assertTrue("正半轴应算成有声音", pcm16Rms(loud, 0, loud.size) > 0.4)

        val negative = ByteArray(800)
        for (i in 0 until 400) {
            negative[i * 2] = 0x00
            negative[i * 2 + 1] = 0xC0.toByte() // 0xC000 = -16384（小端有符号）
        }
        assertTrue("负半轴同样要算成有声音", pcm16Rms(negative, 0, negative.size) > 0.4)
    }

    @Test
    fun `silence before any speech never finishes`() {
        val gate = VoiceActivityGate()
        // 刚进语音模式、用户还没开口：绝不能因为「安静」就立刻判说完
        var at = 0L
        while (at < 5_000) {
            assertEquals(VoiceGateDecision.KeepGoing, gate.onFrame(0.001, at))
            at += 128
        }
    }

    @Test
    fun `finishes after the configured silence following speech`() {
        val gate = VoiceActivityGate(silenceMs = 1_200)
        assertEquals(VoiceGateDecision.KeepGoing, gate.onFrame(0.2, 0))
        assertEquals(VoiceGateDecision.KeepGoing, gate.onFrame(0.001, 900))
        assertEquals(VoiceGateDecision.Finish, gate.onFrame(0.001, 1_250))
    }

    @Test
    fun `a short pause mid sentence does not cut the user off`() {
        val gate = VoiceActivityGate(silenceMs = 1_200)
        assertEquals(VoiceGateDecision.KeepGoing, gate.onFrame(0.2, 0))
        assertEquals("句中停顿 0.8s 不该收工", VoiceGateDecision.KeepGoing, gate.onFrame(0.001, 800))
        assertEquals(VoiceGateDecision.KeepGoing, gate.onFrame(0.2, 1_000))
        assertEquals(VoiceGateDecision.KeepGoing, gate.onFrame(0.001, 1_900))
        assertEquals(VoiceGateDecision.Finish, gate.onFrame(0.001, 2_300))
    }

    @Test
    fun `max duration finishes even while the user keeps talking`() {
        val gate = VoiceActivityGate(maxMs = 30_000)
        assertEquals(VoiceGateDecision.KeepGoing, gate.onFrame(0.3, 0))
        assertEquals(VoiceGateDecision.Finish, gate.onFrame(0.3, 30_000))
    }
}
