package com.mpi.app.data

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * PCM16 单声道一小段的均方根（音量）——归一化到 0..1，纯函数可单测。
 *
 * 用 RMS 而不是峰值：说话时的尖峰很常见，峰值判「有人说话」会过度敏感（呼吸、键盘声都算）。
 */
internal fun pcm16Rms(bytes: ByteArray, offset: Int, length: Int): Double {
    if (length <= 1) return 0.0
    var sum = 0.0
    var count = 0
    var i = offset
    val end = minOf(offset + length, bytes.size) - 1
    while (i < end) {
        // 小端 16 位有符号
        val sample = ((bytes[i + 1].toInt() shl 8) or (bytes[i].toInt() and 0xff)).toShort().toInt()
        val normalized = sample / 32768.0
        sum += normalized * normalized
        count++
        i += 2
    }
    if (count == 0) return 0.0
    return sqrt(sum / count).coerceIn(0.0, 1.0)
}

/** 判定结果：继续收 / 可以收工了。 */
enum class VoiceGateDecision { KeepGoing, Finish }

/**
 * 「说完了吗」的判定（纯函数式状态机，可单测）——语音模式用它自动收尾，用户不用动手。
 *
 * 规则（按顺序）：
 * 1. **先说上话才算开始**：一直没超过阈值就一直录（否则一进语音模式就被「静音」立刻结束）；
 * 2. 说过话之后，连续 [silenceMs] 毫秒低于阈值 → 判定说完；
 * 3. 兜底 [maxMs] 毫秒无条件结束（防止一直说 / 环境噪声不停）。
 *
 * 阈值取 0.02：16kHz 单声道下，安静房间的本底噪声通常 < 0.01，正常说话 0.05~0.3。
 */
class VoiceActivityGate(
    private val threshold: Double = DEFAULT_THRESHOLD,
    private val silenceMs: Long = DEFAULT_SILENCE_MS,
    private val maxMs: Long = DEFAULT_MAX_MS,
) {
    private var spoke = false
    private var lastVoiceAt = 0L

    /** 丢一帧进来；[atMs] 是相对录音开始的毫秒。 */
    fun onFrame(rms: Double, atMs: Long): VoiceGateDecision {
        if (atMs >= maxMs) return VoiceGateDecision.Finish
        if (rms >= threshold) {
            spoke = true
            lastVoiceAt = atMs
            return VoiceGateDecision.KeepGoing
        }
        if (!spoke) return VoiceGateDecision.KeepGoing
        return if (atMs - lastVoiceAt >= silenceMs) VoiceGateDecision.Finish else VoiceGateDecision.KeepGoing
    }

    companion object {
        const val DEFAULT_THRESHOLD = 0.02
        const val DEFAULT_SILENCE_MS = 1_200L
        /** 单段最长 30 秒：正常一句话远用不到，纯粹是防呆。 */
        const val DEFAULT_MAX_MS = 30_000L
    }
}
