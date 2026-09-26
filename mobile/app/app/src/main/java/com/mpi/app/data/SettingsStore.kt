package com.mpi.app.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** 外观模式（与桌面端同语义：跟随系统 / 浅色 / 深色）。 */
enum class Appearance {
    System,
    Light,
    Dark,
    ;

    val wire: String
        get() = when (this) {
            System -> "system"
            Light -> "light"
            Dark -> "dark"
        }

    companion object {
        /** 未知取值一律回到「跟随系统」——最不意外。 */
        fun fromStored(value: String?): Appearance = when (value) {
            "light" -> Light
            "dark" -> Dark
            else -> System
        }
    }
}

/** 字号档位（设计文档 §5.2：设置 → 字号 小 / 标准 / 大）。 */
enum class FontSize(val scale: Float) {
    Small(0.9f),
    Normal(1f),
    Large(1.15f),
    ;

    val wire: String
        get() = when (this) {
            Small -> "small"
            Normal -> "normal"
            Large -> "large"
        }

    companion object {
        fun fromStored(value: String?): FontSize = when (value) {
            "small" -> Small
            "large" -> Large
            else -> Normal
        }
    }
}

/**
 * 「对话完成」语音播报念什么。
 *
 * 固定语短、不吵；回复摘要信息多，但代码/符号念出来不好听——播报前会先去掉代码围栏、
 * 压平空白、再截短。默认固定语（最不打扰）。
 */
enum class VoiceSpeechContent {
    Fixed,
    Reply,
    ;

    val wire: String
        get() = when (this) {
            Fixed -> "fixed"
            Reply -> "reply"
        }

    companion object {
        /** 未知取值回到「固定语」。 */
        fun fromStored(value: String?): VoiceSpeechContent = when (value) {
            "reply" -> Reply
            else -> Fixed
        }
    }
}

data class AppSettings(
    val appearance: Appearance = Appearance.System,
    val fontSize: FontSize = FontSize.Normal,
    /** 会话视图是否显示工具（bash/read/edit…）调用行。默认显示。 */
    val showToolCalls: Boolean = true,
    /** 会话视图是否显示思考过程块。默认显示。 */
    val showThinking: Boolean = true,
    /**
     * 手机发起的回合在**后台/锁屏**跑完时发系统通知。默认开。
     *
     * 手机上「发完就揣起来」是主场景，不给提示根本不知道跑完没有；
     * 前台盯着屏幕看、以及桌面发起的回合都不打扰（判定见 `Notifier.shouldNotifyTurnComplete`）。
     */
    val notifyOnTurnComplete: Boolean = true,
    /**
     * 「对话完成」时**念一句**（系统 TTS；念什么由 [voiceSpeechContent] 决定）。默认开。
     *
     * 触发条件与 [notifyOnTurnComplete] **不同**：通知走飞书已读口径（不区分谁发起，
     * 只看有没有在看着该会话）；出声更打扰，所以语音只念**手机发起的回合**，且挂在
     * 当前打开会话的 running→false 回调上。引擎缺失 / 中文语音包没装时静默降级为「只发通知」。
     */
    val speakTurnComplete: Boolean = true,
    /** 播报念什么：固定语 / 回复摘要（仅在 [speakTurnComplete] 开着时有意义）。 */
    val voiceSpeechContent: VoiceSpeechContent = VoiceSpeechContent.Fixed,
    /** 固定语模板（用户可改）：`{title}` 替换为会话标题，不写就不念标题；空白回落默认。 */
    val voiceFixedPhrase: String = Notifier.DEFAULT_FIXED_PHRASE,
    /**
     * 通话中也尝试播报（含微信这类 VoIP）。默认关。
     *
     * 关掉时：通话中直接跳过（系统会把媒体音/TTS 压掉，念了听不到，还可能被通话对方听到）。
     * 开了也只是**尝试**——部分 ROM 通话中整个静音媒体流，那时这个开关也救不回来。
     */
    val speakDuringCall: Boolean = false,
    /**
     * 后台/锁屏播报保活：手机发起的回合在跑时持 wakelock，防 CPU 睡 / Doze（见 [TurnWakeLock]）。默认开。
     *
     * 只解决「系统睡过去 → 事件收不及时 → 播报晚到/漏掉」；ROM 本身锁屏静音媒体流的话
     * App 侧无解（与通话中同一性质）。
     */
    val speakInBackground: Boolean = true,
)

/**
 * 本地界面设置（外观 / 字号）。
 *
 * 明文 SharedPreferences 是刻意的：这些不是敏感数据，不值得动用 Keystore 加密卷
 * （那是给配对凭证与设备身份用的）。损坏 / 缺失一律回落到默认值，不抛异常。
 */
class SettingsStore(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val _settings = MutableStateFlow(read())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    fun setAppearance(value: Appearance) {
        prefs.edit().putString(KEY_APPEARANCE, value.wire).apply()
        _settings.value = read()
    }

    fun setFontSize(value: FontSize) {
        prefs.edit().putString(KEY_FONT_SIZE, value.wire).apply()
        _settings.value = read()
    }

    fun setShowToolCalls(value: Boolean) {
        prefs.edit().putBoolean(KEY_SHOW_TOOL_CALLS, value).apply()
        _settings.value = read()
    }

    fun setShowThinking(value: Boolean) {
        prefs.edit().putBoolean(KEY_SHOW_THINKING, value).apply()
        _settings.value = read()
    }

    fun setNotifyOnTurnComplete(value: Boolean) {
        prefs.edit().putBoolean(KEY_NOTIFY_TURN_COMPLETE, value).apply()
        _settings.value = read()
    }

    fun setSpeakTurnComplete(value: Boolean) {
        prefs.edit().putBoolean(KEY_SPEAK_TURN_COMPLETE, value).apply()
        _settings.value = read()
    }

    fun setVoiceSpeechContent(value: VoiceSpeechContent) {
        prefs.edit().putString(KEY_VOICE_SPEECH_CONTENT, value.wire).apply()
        _settings.value = read()
    }

    fun setVoiceFixedPhrase(value: String) {
        // 压平空白；空串回落默认，避免存下一句念不出东西的「固定语」。
        val normalized = value.replace(Regex("\\s+"), " ").trim()
        prefs.edit().putString(KEY_VOICE_FIXED_PHRASE, normalized.ifEmpty { Notifier.DEFAULT_FIXED_PHRASE }).apply()
        _settings.value = read()
    }

    fun setSpeakDuringCall(value: Boolean) {
        prefs.edit().putBoolean(KEY_SPEAK_DURING_CALL, value).apply()
        _settings.value = read()
    }

    fun setSpeakInBackground(value: Boolean) {
        prefs.edit().putBoolean(KEY_SPEAK_IN_BACKGROUND, value).apply()
        _settings.value = read()
    }

    private fun read(): AppSettings = AppSettings(
        appearance = Appearance.fromStored(prefs.getString(KEY_APPEARANCE, null)),
        fontSize = FontSize.fromStored(prefs.getString(KEY_FONT_SIZE, null)),
        showToolCalls = prefs.getBoolean(KEY_SHOW_TOOL_CALLS, true),
        showThinking = prefs.getBoolean(KEY_SHOW_THINKING, true),
        notifyOnTurnComplete = prefs.getBoolean(KEY_NOTIFY_TURN_COMPLETE, true),
        speakTurnComplete = prefs.getBoolean(KEY_SPEAK_TURN_COMPLETE, true),
        voiceSpeechContent = VoiceSpeechContent.fromStored(prefs.getString(KEY_VOICE_SPEECH_CONTENT, null)),
        // 旧版本没写过这个键 / 值损坏时回落默认。
        voiceFixedPhrase = prefs.getString(KEY_VOICE_FIXED_PHRASE, null)?.takeIf { it.isNotBlank() }
            ?: Notifier.DEFAULT_FIXED_PHRASE,
        speakDuringCall = prefs.getBoolean(KEY_SPEAK_DURING_CALL, false),
        speakInBackground = prefs.getBoolean(KEY_SPEAK_IN_BACKGROUND, true),
    )

    companion object {
        private const val PREFS_NAME = "mpi-settings"
        private const val KEY_APPEARANCE = "appearance"
        private const val KEY_FONT_SIZE = "fontSize"
        private const val KEY_SHOW_TOOL_CALLS = "showToolCalls"
        private const val KEY_SHOW_THINKING = "showThinking"
        private const val KEY_NOTIFY_TURN_COMPLETE = "notifyOnTurnComplete"
        private const val KEY_SPEAK_TURN_COMPLETE = "speakTurnComplete"
        private const val KEY_VOICE_SPEECH_CONTENT = "voiceSpeechContent"
        private const val KEY_VOICE_FIXED_PHRASE = "voiceFixedPhrase"
        private const val KEY_SPEAK_DURING_CALL = "speakDuringCall"
        private const val KEY_SPEAK_IN_BACKGROUND = "speakInBackground"
    }
}
