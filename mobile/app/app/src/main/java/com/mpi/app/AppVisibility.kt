package com.mpi.app

import android.app.KeyguardManager
import android.content.Context
import android.os.PowerManager
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * App 是否在前台（进程级标记）。
 *
 * 只服务一个判断：**「对话完成」通知只在后台/锁屏时发**——盯着屏幕看回复时再响一次
 * 纯属打扰（用户确认的口径）。
 *
 * ⚠️ **「前台」是两个信号的合成，而且判定必须是实时的**（2026-09-26 真机）：
 *  - Activity 侧只给两个原始信号：[resumed]（画面可见）与 [focused]（窗口有焦点）；
 *  - 但**只看这两个缓存信号会误判**：熄屏 / 锁屏在部分 ROM 上不一定立刻走到 onPause，
 *    缓存值会停在 true，于是后台跑完的回合被当成「用户正看着」，通知静默不发——
 *    诊断页当时报的就是「跳过：App 在前台」；
 *  - 所以通知判定一律用 [isForegroundNow]：在缓存信号之上**实时**查屏幕是否亮着、是否锁屏。
 */
object AppVisibility {
    @Volatile
    private var appContext: Context? = null

    /** Activity 侧信号：画面可见（resumed）。 */
    @Volatile
    var resumed: Boolean = false
        private set

    /** Activity 侧信号：窗口有焦点。 */
    @Volatile
    var focused: Boolean = false
        private set

    /** 两个 Activity 信号的合成（**不含**屏幕/锁屏）——只用于诊断展示与前台服务口径。 */
    @Volatile
    var foreground: Boolean = false
        private set

    /** 最近一次信号切换的说明 + 时刻（诊断页展示）：例如「后台（窗口失去焦点 · 21:32:10）」。 */
    @Volatile
    var lastChange: String = "启动以来未变化"

    /** 由 [AppContainer] 在启动时注入（查屏幕/锁屏状态要 Context）。 */
    fun attach(context: Context) {
        appContext = context.applicationContext
    }

    /** 记录一次 Activity 信号变化（由 [MainActivity] 调用）。 */
    fun set(resumed: Boolean, focused: Boolean, reason: String) {
        this.resumed = resumed
        this.focused = focused
        val next = resumed && focused
        foreground = next
        val stamp = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        lastChange = "${if (next) "前台" else "后台"}（$reason · $stamp）"
    }

    /** 屏幕是否亮着（实时）。 */
    fun screenInteractive(): Boolean {
        val power = appContext?.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return power.isInteractive
    }

    /** 是否处于锁屏（实时）。 */
    fun keyguardLocked(): Boolean {
        val keyguard = appContext?.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager ?: return false
        return keyguard.isKeyguardLocked
    }

    /**
     * 通知判定用的「现在算不算前台」：Activity 信号 **且** 屏幕亮着 **且** 未锁屏。
     *
     * **必须实时算**（不能拿 [foreground] 这个缓存值）：熄屏/锁屏不一定会立刻触发 onPause，
     * 缓存值会停在 true，把「用户已经离开」误判成「正在看」，通知就被静默跳过了。
     */
    fun isForegroundNow(): Boolean = foreground && screenInteractive() && !keyguardLocked()

    /** 判定依据（诊断页与通知原因里展示）：一眼看清是哪个信号说「前台」。 */
    fun detail(): String =
        "resumed=$resumed focused=$focused screen=${if (screenInteractive()) "亮" else "灭"} " +
            "locked=${if (keyguardLocked()) "是" else "否"}"
}
