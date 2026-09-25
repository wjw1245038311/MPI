package com.mpi.app.data

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * 44 字节 RIFF/WAVE 头 + PCM16（与 PWA `encodeWavPcm16` 和旧壳输出完全一致，
 * 主机端无需区分录音来源）。纯函数，可单测。
 */
internal fun encodeWavPcm16(pcm: ByteArray, sampleRate: Int): ByteArray {
    val header = ByteArray(44)
    fun le(offset: Int, value: Int) {
        header[offset] = (value and 0xff).toByte()
        header[offset + 1] = ((value shr 8) and 0xff).toByte()
        header[offset + 2] = ((value shr 16) and 0xff).toByte()
        header[offset + 3] = ((value shr 24) and 0xff).toByte()
    }

    fun le16(offset: Int, value: Int) {
        header[offset] = (value and 0xff).toByte()
        header[offset + 1] = ((value shr 8) and 0xff).toByte()
    }

    fun ascii(offset: Int, text: String) {
        for ((i, c) in text.withIndex()) header[offset + i] = c.code.toByte()
    }

    ascii(0, "RIFF")
    le(4, 36 + pcm.size)
    ascii(8, "WAVE")
    ascii(12, "fmt ")
    le(16, 16)
    le16(20, 1)                       // PCM
    le16(22, 1)                       // mono
    le(24, sampleRate)
    le(28, sampleRate * 2)            // byte rate
    le16(32, 2)                       // block align
    le16(34, 16)                      // bits per sample
    ascii(36, "data")
    le(40, pcm.size)
    return header + pcm
}

/**
 * 原生录音（PCM16 / 16 kHz / 单声道）——语音输入的采集端（M4）。
 *
 * 为什么不用 WebView 的 getUserMedia：部分国产 ROM 的 WebView 音频栈开不了设备，
 * 恒报 `NotReadableError`（旧壳实测荣耀 MagicOS 三组约束全被 HAL 拒绝）。原生
 * `AudioRecord` 走普通 App 录音通路，不受 WebView 实现影响。
 *
 * 音频源按 VOICE_RECOGNITION → MIC → DEFAULT 逐级回退；权限由调用方（UI）保证。
 */
class VoiceRecorder {

    private val lock = Any()
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private var buffer: ByteArrayOutputStream? = null

    @Volatile
    private var running = false

    /** 录制中（UI 用来切换按钮态）。 */
    val isRecording: Boolean get() = running

    /**
     * 开始录音。
     *
     * @param onLevel 每帧回调一次归一化音量（0..1）——语音模式用它做静音判定。
     *   回调在**录音线程**上执行，必须轻量且线程安全（异常会被吞掉，不影响录音）。
     */
    fun start(onLevel: ((Double) -> Unit)? = null): Result<Unit> = synchronized(lock) {
        if (running) return Result.success(Unit)
        var last = "无法启动录音"
        for (source in SOURCES) {
            val outcome = tryStart(source, onLevel)
            if (outcome.isSuccess) return outcome
            last = outcome.exceptionOrNull()?.message ?: last
        }
        Result.failure(IllegalStateException(last))
    }

    /** 停止并返回 base64 的 WAV。太短视为无效。 */
    fun stop(): Result<String> {
        val pcm = release()
        if (pcm.size < MIN_BYTES) return Result.failure(IllegalStateException("录音太短"))
        val wav = encodeWavPcm16(pcm, SAMPLE_RATE)
        return Result.success(Base64.encodeToString(wav, Base64.NO_WRAP))
    }

    /** 放弃本次录音（用户取消）。 */
    fun cancel() {
        release()
    }

    private fun release(): ByteArray {
        val recorder: AudioRecord?
        val out: ByteArrayOutputStream?
        synchronized(lock) {
            running = false
            recorder = record
            out = buffer
            record = null
            buffer = null
        }
        thread?.let { runCatching { it.join(600) } }
        thread = null
        recorder?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        return out?.toByteArray() ?: ByteArray(0)
    }

    private fun tryStart(source: Int, onLevel: ((Double) -> Unit)?): Result<Unit> {
        val min = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (min <= 0) return Result.failure(IllegalStateException("设备不支持录音"))

        val recorder = try {
            @Suppress("MissingPermission") // 调用方已拿到运行时权限
            AudioRecord(
                source,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(min, SAMPLE_RATE / 2),
            )
        } catch (t: Throwable) {
            return Result.failure(IllegalStateException("录音设备不可用：${t.message ?: t.javaClass.simpleName}"))
        }
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            return Result.failure(IllegalStateException("录音设备初始化失败"))
        }

        val out = ByteArrayOutputStream(SAMPLE_RATE * 2 * 10)
        try {
            recorder.startRecording()
        } catch (t: Throwable) {
            recorder.release()
            return Result.failure(IllegalStateException("无法开始录音：${t.message ?: t.javaClass.simpleName}"))
        }
        if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            recorder.release()
            return Result.failure(IllegalStateException("麦克风被占用"))
        }

        record = recorder
        buffer = out
        running = true
        thread = Thread({ readLoop(recorder, out, onLevel) }, "mpi-voice-record").also {
            it.isDaemon = true
            it.start()
        }
        return Result.success(Unit)
    }

    private fun readLoop(recorder: AudioRecord, out: ByteArrayOutputStream, onLevel: ((Double) -> Unit)?) {
        val chunk = ByteArray(4096)
        while (running) {
            val n = runCatching { recorder.read(chunk, 0, chunk.size) }.getOrDefault(-1)
            if (n > 0) {
                synchronized(lock) { if (running) out.write(chunk, 0, n) }
                onLevel?.let { callback -> runCatching { callback(pcm16Rms(chunk, 0, n)) } }
            } else if (n < 0) {
                break
            }
        }
    }

    companion object {
        const val SAMPLE_RATE = 16000

        /** 最短有效录音（0.5s，与 PWA 侧下限一致）。 */
        private const val MIN_BYTES = SAMPLE_RATE / 2 * 2

        private val SOURCES = intArrayOf(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            MediaRecorder.AudioSource.MIC,
            MediaRecorder.AudioSource.DEFAULT,
        )
    }
}
