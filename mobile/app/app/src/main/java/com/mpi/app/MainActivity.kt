package com.mpi.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.mpi.app.data.Notifier
import com.mpi.app.ui.BenchmarkScreen
import com.mpi.app.ui.EXTRA_BENCHMARK
import com.mpi.app.ui.MpiAppRoot
import com.mpi.app.ui.theme.MpiTheme

/**
 * 唯一的 Activity。
 *
 * 调试入口（M0-7 的滚动基准页）：
 * `adb shell am start -n com.mpi.app/.MainActivity --ez benchmark true`
 */
class MainActivity : ComponentActivity() {

    private val container: AppContainer by lazy { AppContainer(applicationContext) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // 通知点击带来的会话深链（M5）：等连接就绪后由 UI 消费
        container.pendingThreadOpen.value = intent?.getStringExtra(Notifier.EXTRA_THREAD_ID)

        val benchmark = intent?.getBooleanExtra(EXTRA_BENCHMARK, false) == true
        setContent {
            if (benchmark) {
                MpiTheme { BenchmarkScreen() }
            } else {
                MpiAppRoot(container)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // 已在前台/后台时再点通知：更新深链目标（UI 会 collect 到）
        container.pendingThreadOpen.value = intent.getStringExtra(Notifier.EXTRA_THREAD_ID)
    }

    // 前台标记（驱动「对话完成」通知只在后台发）——见 AppVisibility。
    private var resumed = false
    private var focused = false

    override fun onResume() {
        super.onResume()
        resumed = true
        syncForeground("画面可见")
    }

    override fun onPause() {
        resumed = false
        syncForeground("画面不可见")
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        focused = hasFocus
        syncForeground(if (hasFocus) "窗口获得焦点" else "窗口失去焦点")
    }

    /**
     * 前台 = **画面可见（resumed）且窗口有焦点**。
     *
     * 为什么不用 onStart/onStop：那是「完全不可见」才触发，真机上用它判断「用户是不是在
     * 看这个会话」明显偏宽——切到最近任务、下拉通知栏、熄屏都可能还停在 started 状态，
     * 于是后台跑完的回合被当成「前台看着」，通知就静默不发了
     * （2026-09-25 真机：诊断页报的正是「跳过：App 在前台」）。
     * resumed + 焦点是实时信号，任一侧丢失都算后台；回到前台两者都会恢复，不会卡死。
     */
    private fun syncForeground(reason: String) {
        val next = resumed && focused
        if (!AppVisibility.set(next, reason)) return
        // 人都回到 App 了，挂着那条「回复已完成」没意义
        if (next) container.notifier.cancelTurnComplete()
    }
}
