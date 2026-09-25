package com.mpi.app

/**
 * App 是否在前台（进程级标记）。
 *
 * 只服务一个判断：**「对话完成」通知只在后台/锁屏时发**——盯着屏幕看回复时再响一次
 * 纯属打扰（用户确认的口径）。由 [MainActivity] 的 onStart/onStop 维护，
 * 本 App 只有一个 Activity，所以一个标记就够，不需要引入生命周期库。
 */
object AppVisibility {
    /** 画面可见（Activity resumed）**且**窗口有焦点时才为 true。 */
    @Volatile
    var foreground: Boolean = false

    /** 最近一次切换的说明 + 时刻（诊断页展示）：例如「后台（窗口失去焦点 · 21:32:10）」。 */
    @Volatile
    var lastChange: String = "启动以来未变化"

    /** 记录一次切换（供 [MainActivity] 调用）：返回是否真的变了。 */
    fun set(next: Boolean, reason: String): Boolean {
        val changed = next != foreground
        foreground = next
        val stamp = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
        lastChange = "${if (next) "前台" else "后台"}（$reason · $stamp）"
        return changed
    }
}
