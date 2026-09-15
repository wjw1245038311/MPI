package com.mpi.remote

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * 壳内原生录音（PCM16 / 16 kHz / 单声道）——PWA 语音输入在壳里的采集后端。
 *
 * 为什么不用 WebView 的 getUserMedia：部分国产 ROM 的 WebView 音频采集栈开不了
 * 设备，getUserMedia 恒报 NotReadableError "Could not start audio source"（实测
 * 荣耀 Magic5 / MagicOS：默认、去 DSP、单声道三组约束全部被 HAL 拒绝）。原生
 * AudioRecord 走的是普通 App 录音通路，不受 WebView 实现与厂商 ROM 策略影响。
 *
 * 输出与 PWA 侧 encodeWavPcm16 完全一致（44 字节 RIFF/WAVE 头 + PCM16），宿主
 * 无需区分录音来源。音频源按 VOICE_RECOGNITION → MIC → DEFAULT 逐级回退。
 *
 * 线程模型：start() 起一个读线程把 PCM 追加进内存缓冲，stop() 停表并把缓冲补
 * WAV 头后 base64 返回。JS 桥调用发生在 WebView 的 JavaBridge 线程上，所有入口
 * 用 [lock] 串行化。
 */
object NativeRecorder {

    const val SAMPLE_RATE = 16000

    /** 最短有效录音（0.5s，与 PWA 侧下限一致）。 */
    private const val MIN_BYTES = SAMPLE_RATE / 2 * 2

    private val lock = Any()
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private var buffer: ByteArrayOutputStream? = null

    @Volatile
    private var running = false

    /** 最近一次启动结果（?dbg=1 浮层取证用）。 */
    @Volatile
    var lastResult: String = "-"
        private set

    fun isRecording(): Boolean = running

    /** @return "ok" 或 "err:<原因>"。 */
    fun start(): String {
        synchronized(lock) {
            if (running) return "ok"
            var lastError = "err:no-source"
            for (source in intArrayOf(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                MediaRecorder.AudioSource.MIC,
                MediaRecorder.AudioSource.DEFAULT,
            )) {
                val started = tryStart(source)
                if (started == "ok") {
                    lastResult = "ok src=$source"
                    ShellLog.log("nativeRecord start src=$source")
                    return "ok"
                }
                lastError = started
                ShellLog.log("nativeRecord $started")
            }
            lastResult = lastError
            return lastError
        }
    }

    /** 启动指定音频源的采集。@return "ok" 或 "err:<原因>"。 */
    private fun tryStart(source: Int): String {
        val min = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (min <= 0) return "err:minBuffer=$min"
        val recorder = try {
            @Suppress("MissingPermission") // 调用方（JS 桥）已保证运行时权限
            AudioRecord(
                source,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(min, SAMPLE_RATE / 2),
            )
        } catch (t: Throwable) {
            return "err:ctor ${t.javaClass.simpleName}:${t.message}"
        }
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            return "err:notInitialized src=$source"
        }
        val out = ByteArrayOutputStream(SAMPLE_RATE * 2 * 10)
        try {
            recorder.startRecording()
        } catch (t: Throwable) {
            recorder.release()
            return "err:start ${t.javaClass.simpleName}:${t.message}"
        }
        if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            recorder.release()
            return "err:notRecording src=$source"
        }
        record = recorder
        buffer = out
        running = true
        thread = Thread({ readLoop(recorder, out) }, "mpi-native-record").also {
            it.isDaemon = true
            it.start()
        }
        return "ok"
    }

    private fun readLoop(recorder: AudioRecord, out: ByteArrayOutputStream) {
        val chunk = ByteArray(4096)
        while (running) {
            val n = try {
                recorder.read(chunk, 0, chunk.size)
            } catch (t: Throwable) {
                ShellLog.log("nativeRecord read ${t.javaClass.simpleName}:${t.message}")
                -1
            }
            if (n > 0) {
                synchronized(lock) { if (running) out.write(chunk, 0, n) }
            } else if (n < 0) {
                break
            }
        }
    }

    /** 停止并返回 `{"ok":true,"audioB64":"…","sampleRate":16000}` 或 `{"error":"…"}`。 */
    fun stop(): String {
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
        val pcm = out?.toByteArray() ?: ByteArray(0)
        if (pcm.size < MIN_BYTES) return "{\"error\":\"录音太短\"}"
        val wav = wav(pcm)
        ShellLog.log("nativeRecord stop bytes=${pcm.size}")
        return "{\"ok\":true,\"audioB64\":\"${Base64.encodeToString(wav, Base64.NO_WRAP)}\",\"sampleRate\":$SAMPLE_RATE}"
    }

    /** 放弃本次录音（用户取消）。 */
    fun cancel() {
        val recorder: AudioRecord?
        synchronized(lock) {
            running = false
            recorder = record
            record = null
            buffer = null
        }
        thread?.let { runCatching { it.join(600) } }
        thread = null
        recorder?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
    }

    /** 44 字节 RIFF/WAVE 头 + PCM16（与 PWA encodeWavPcm16 输出一致）。 */
    private fun wav(pcm: ByteArray): ByteArray {
        val header = ByteArray(44)
        val le = { offset: Int, value: Int ->
            header[offset] = (value and 0xff).toByte()
            header[offset + 1] = ((value shr 8) and 0xff).toByte()
            header[offset + 2] = ((value shr 16) and 0xff).toByte()
            header[offset + 3] = ((value shr 24) and 0xff).toByte()
        }
        val le16 = { offset: Int, value: Int ->
            header[offset] = (value and 0xff).toByte()
            header[offset + 1] = ((value shr 8) and 0xff).toByte()
        }
        for ((i, c) in "RIFF".withIndex()) header[i] = c.code.toByte()
        le(4, 36 + pcm.size)
        for ((i, c) in "WAVE".withIndex()) header[8 + i] = c.code.toByte()
        for ((i, c) in "fmt ".withIndex()) header[12 + i] = c.code.toByte()
        le(16, 16)                       // fmt chunk size
        le16(20, 1)                      // PCM
        le16(22, 1)                      // mono
        le(24, SAMPLE_RATE)
        le(28, SAMPLE_RATE * 2)          // byte rate
        le16(32, 2)                      // block align
        le16(34, 16)                     // bits per sample
        for ((i, c) in "data".withIndex()) header[36 + i] = c.code.toByte()
        le(40, pcm.size)
        return header + pcm
    }
}
