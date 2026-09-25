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
    /**
     * 手机发起的回合在**后台/锁屏**跑完时发系统通知。默认开。
     *
     * 手机上「发完就揣起来」是主场景，不给提示根本不知道跑完没有；
     * 前台盯着屏幕看、以及桌面发起的回合都不打扰（判定见 `Notifier.shouldNotifyTurnComplete`）。
     */
    val notifyOnTurnComplete: Boolean = true,
    /**
     * 「对话完成」时**念一句**（系统 TTS，固定语，不是念回复正文）。默认开。
     *
     * 触发条件与 [notifyOnTurnComplete] 完全一致（仅后台/锁屏 + 仅手机发起的回合）；
     * 引擎缺失 / 中文语音包没装时静默降级为「只发通知」。
     */
    val speakTurnComplete: Boolean = true,
    /** 播报念什么：固定语 / 回复摘要（仅在 [speakTurnComplete] 开着时有意义）。 */
    val voiceSpeechContent: VoiceSpeechContent = VoiceSpeechContent.Fixed,
    /**
     * 通话中也尝试播报（含微信这类 VoIP）。默认关。
     *
     * 关掉时：通话中直接跳过（系统会把媒体音/TTS 压掉，念了听不到，还可能被通话对方听到）。
     * 开了也只是**尝试**——部分 ROM 通话中整个静音媒体流，那时这个开关也救不回来。
     */
    val speakDuringCall: Boolean = false,
    /**
     * 会话里**左划**打开「会话节点」面板（对齐桌面端左侧的用户消息导航）。默认开。
     *
     * 与已有的「右划拉出会话列表」互为镜像；不想要这个手势就从设置里关掉
     * （用户口径：左划是否生效由设置控制）。
     */
    val swipeNodePanel: Boolean = true,
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

    fun setSpeakDuringCall(value: Boolean) {
        prefs.edit().putBoolean(KEY_SPEAK_DURING_CALL, value).apply()
        _settings.value = read()
    }

    fun setSwipeNodePanel(value: Boolean) {
        prefs.edit().putBoolean(KEY_SWIPE_NODE_PANEL, value).apply()
        _settings.value = read()
    }

    private fun read(): AppSettings = AppSettings(
        appearance = Appearance.fromStored(prefs.getString(KEY_APPEARANCE, null)),
        fontSize = FontSize.fromStored(prefs.getString(KEY_FONT_SIZE, null)),
        showToolCalls = prefs.getBoolean(KEY_SHOW_TOOL_CALLS, true),
        notifyOnTurnComplete = prefs.getBoolean(KEY_NOTIFY_TURN_COMPLETE, true),
        speakTurnComplete = prefs.getBoolean(KEY_SPEAK_TURN_COMPLETE, true),
        voiceSpeechContent = VoiceSpeechContent.fromStored(prefs.getString(KEY_VOICE_SPEECH_CONTENT, null)),
        speakDuringCall = prefs.getBoolean(KEY_SPEAK_DURING_CALL, false),
        swipeNodePanel = prefs.getBoolean(KEY_SWIPE_NODE_PANEL, true),
    )

    companion object {
        private const val PREFS_NAME = "mpi-settings"
        private const val KEY_APPEARANCE = "appearance"
        private const val KEY_FONT_SIZE = "fontSize"
        private const val KEY_SHOW_TOOL_CALLS = "showToolCalls"
        private const val KEY_NOTIFY_TURN_COMPLETE = "notifyOnTurnComplete"
        private const val KEY_SPEAK_TURN_COMPLETE = "speakTurnComplete"
        private const val KEY_VOICE_SPEECH_CONTENT = "voiceSpeechContent"
        private const val KEY_SPEAK_DURING_CALL = "speakDuringCall"
        private const val KEY_SWIPE_NODE_PANEL = "swipeNodePanel"
    }
}
