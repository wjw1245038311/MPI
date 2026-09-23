package com.mpi.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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

        val benchmark = intent?.getBooleanExtra(EXTRA_BENCHMARK, false) == true
        setContent {
            if (benchmark) {
                MpiTheme { BenchmarkScreen() }
            } else {
                MpiAppRoot(container)
            }
        }
    }
}
