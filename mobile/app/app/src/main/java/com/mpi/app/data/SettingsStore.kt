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

data class AppSettings(
    val appearance: Appearance = Appearance.System,
    val fontSize: FontSize = FontSize.Normal,
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

    private fun read(): AppSettings = AppSettings(
        appearance = Appearance.fromStored(prefs.getString(KEY_APPEARANCE, null)),
        fontSize = FontSize.fromStored(prefs.getString(KEY_FONT_SIZE, null)),
    )

    companion object {
        private const val PREFS_NAME = "mpi-settings"
        private const val KEY_APPEARANCE = "appearance"
        private const val KEY_FONT_SIZE = "fontSize"
    }
}
