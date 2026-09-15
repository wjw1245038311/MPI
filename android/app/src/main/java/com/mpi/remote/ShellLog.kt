package com.mpi.remote

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 壳侧取证：最近的 load/scan/update 事件 → logcat + SharedPreferences。
 *
 * PWA 的 ?dbg=1 浮层经 MpiShell.scanDiagnostics() 读回，真机「黑屏无反馈」时
 * 不用 adb 就能定位卡在哪一跳（网络不通 / TLS / 页面加载 / 扫码识别）。
 */
object ShellLog {
    private const val PREFS = "mpi-shell-log"
    private const val KEY_EVENTS = "events"
    private const val MAX_EVENTS = 20

    private var prefs: android.content.SharedPreferences? = null
    private val buffer = ArrayDeque<String>()

    fun init(context: Context) {
        if (prefs != null) return
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // 恢复上次会话的尾部——壳崩溃重启后现场不丢。
        try {
            val saved = JSONArray(prefs?.getString(KEY_EVENTS, "[]") ?: "[]")
            for (i in 0 until saved.length()) buffer.addLast(saved.getString(i))
        } catch (_: Exception) { /* 损坏就重头记 */ }
    }

    @Synchronized
    fun log(event: String) {
        android.util.Log.i("MpiShell", event)
        val line = "${System.currentTimeMillis()} $event"
        buffer.addLast(line)
        while (buffer.size > MAX_EVENTS) buffer.removeFirst()
        try {
            prefs?.edit()?.putString(KEY_EVENTS, JSONArray(buffer.toList()).toString())?.apply()
        } catch (_: Exception) { /* 取证不能影响主流程 */ }
    }

    /** MpiShell.scanDiagnostics() 的 JSON 快照：{shellVersion, baseUrl, events}。 */
    @Synchronized
    fun snapshot(version: String, baseUrl: String): String = JSONObject()
        .put("shellVersion", version)
        .put("baseUrl", baseUrl)
        .put("events", JSONArray(buffer.toList()))
        .toString()
}
