package com.mpi.app.data

import android.content.Context

/**
 * 「上一次打开的会话」——重启 App 后优先回到它。
 *
 * 为什么不靠「列表里 updatedAt 最新的那个」：那是「最近**更新**」，不等于「最近
 * **打开**」；而且重启首帧常常是本地缓存列表（可能还没有刚新建的会话），拿它做
 * 自动打开的决定会选错（2026-09-26 真机：新建会话发完消息重启，进的是旧会话）。
 *
 * 存储用独立的 SharedPreferences（与 SettingsStore 分开）：这是「运行时记忆」，
 * 不是用户设置，混在一起会让「重置设置」之类的操作误伤它。
 */
class LastThreadStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var threadId: String?
        get() = prefs.getString(KEY_THREAD_ID, null)?.takeIf { it.isNotBlank() }
        set(value) {
            prefs.edit().apply {
                if (value.isNullOrBlank()) remove(KEY_THREAD_ID) else putString(KEY_THREAD_ID, value)
            }.apply()
        }

    private companion object {
        const val PREFS_NAME = "mpi-last-thread"
        const val KEY_THREAD_ID = "threadId"
    }
}
