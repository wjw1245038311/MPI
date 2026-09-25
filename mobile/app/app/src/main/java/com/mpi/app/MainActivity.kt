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

    // 前后台标记（驱动「对话完成」通知只在后台发）——见 AppVisibility。
    override fun onStart() {
        super.onStart()
        AppVisibility.foreground = true
        // 人都回到 App 了，挂着那条「回复已完成」没意义
        container.notifier.cancelTurnComplete()
    }

    override fun onStop() {
        AppVisibility.foreground = false
        super.onStop()
    }
}
