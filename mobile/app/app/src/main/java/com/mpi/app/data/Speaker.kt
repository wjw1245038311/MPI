package com.mpi.app.data

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * 语音播报：「对话完成」时念一句（用系统内置 TTS，不需要权限、不需要额外依赖、可离线）。
 *
 * 三条硬约束：
 * 1. **失败一律静默**——引擎缺失 / 中文语音包没装 / 初始化失败，都只当没这回事。语音是
 *    加分项，绝不能反过来影响通知与主流程（所以对外只暴露 [speak] 与 [shutdown]，不抛异常）；
 * 2. 初始化是**异步**的：就绪前来的播报先记下来，`onInit` 后补念一次——否则用户第一次
 *    等来的就是「设了却没声音」；
 * 3. 实例复用（每次 new 一个会泄漏引擎连接），进程退出时 [shutdown]。
 *
 * 线程：调用方（回合结束的判定）在后台线程，`onInit` 在主线——状态用锁保护。
 */
class Speaker(context: Context) {

    private val appContext: Context = context.applicationContext
    private var engine: TextToSpeech? = null
    private var ready = false
    private var pending: String? = null

    /** 念一句。引擎没就绪就先排队，永远不抛。 */
    fun speak(text: String) {
        val value = text.trim()
        if (value.isEmpty()) return
        val current: TextToSpeech?
        synchronized(this) {
            if (engine == null) {
                engine = TextToSpeech(appContext) { status -> onInit(status == TextToSpeech.SUCCESS) }
            }
            current = engine
            if (!ready) {
                pending = value
                return
            }
        }
        runCatching { current?.speak(value, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE_ID) }
    }

    fun shutdown() {
        synchronized(this) {
            pending = null
            ready = false
            runCatching { engine?.stop() }
            runCatching { engine?.shutdown() }
            engine = null
        }
    }

    private fun onInit(ok: Boolean) {
        val queued: String?
        synchronized(this) {
            ready = ok
            if (!ok) {
                pending = null
                return
            }
            // 中文语音包缺失时返回 LANG_MISSING_DATA（不是异常）——保持默认语言即可，
            // 系统会退到能用的语音；念不好听也胜过没声音。
            // 注意：setLanguage 返回 int，不是 void，所以在 Kotlin 里只能当方法调，
            // 不能写成 `engine?.language = ...`（合成属性要求 setter 返回 void）。
            runCatching { engine?.setLanguage(Locale.CHINESE) }
            queued = pending
            pending = null
        }
        if (queued != null) speak(queued)
    }

    private companion object {
        const val UTTERANCE_ID = "mpi-turn"
    }
}
