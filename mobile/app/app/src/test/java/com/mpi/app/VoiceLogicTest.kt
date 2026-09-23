package com.mpi.app

import com.mpi.app.data.VoiceRecorder
import com.mpi.app.data.encodeWavPcm16
import org.junit.Assert.assertEquals
import org.junit.Test

/** M4：语音输入的 WAV 封装（纯函数，输出必须与 PWA / 旧壳一致）。 */
class VoiceLogicTest {

    private fun le32(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xff) or
            ((bytes[offset + 1].toInt() and 0xff) shl 8) or
            ((bytes[offset + 2].toInt() and 0xff) shl 16) or
            ((bytes[offset + 3].toInt() and 0xff) shl 24)

    private fun le16(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)

    @Test
    fun `wav carries a 44-byte RIFF header plus the pcm payload`() {
        val pcm = ByteArray(1_000)
        val wav = encodeWavPcm16(pcm, VoiceRecorder.SAMPLE_RATE)

        assertEquals(44 + pcm.size, wav.size)
        assertEquals("RIFF", String(wav, 0, 4, Charsets.US_ASCII))
        assertEquals("WAVE", String(wav, 8, 4, Charsets.US_ASCII))
        assertEquals("fmt ", String(wav, 12, 4, Charsets.US_ASCII))
        assertEquals("data", String(wav, 36, 4, Charsets.US_ASCII))
        assertEquals(36 + pcm.size, le32(wav, 4))
        assertEquals(pcm.size, le32(wav, 40))
    }

    @Test
    fun `format chunk describes 16 kHz mono pcm16`() {
        val wav = encodeWavPcm16(ByteArray(64), VoiceRecorder.SAMPLE_RATE)

        assertEquals(16, le32(wav, 16))                        // fmt chunk size
        assertEquals(1, le16(wav, 20))                         // PCM
        assertEquals(1, le16(wav, 22))                         // mono
        assertEquals(16_000, le32(wav, 24))                    // sample rate
        assertEquals(16_000 * 2, le32(wav, 28))                // byte rate
        assertEquals(2, le16(wav, 32))                         // block align
        assertEquals(16, le16(wav, 34))                        // bits per sample
    }
}
