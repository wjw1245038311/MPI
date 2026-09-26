package com.mpi.app

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
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
        setupRightEdgeBackSwipe()
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
        applySystemGestureExclusion()
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
        AppVisibility.set(resumed = resumed, focused = focused, reason = reason)
        container.foreground.value = AppVisibility.foreground
    }

    /**
     * 把屏幕右边缘从**系统返回手势区**里申请回来（API 29+）。
     *
     * 为什么 View 层还要再做一次：`Modifier.systemGestureExclusion`（MpiApp 里）的生效范围
     * 由框架/ROM 决定，真机实测贴边左划仍被系统吃掉——表现就是弹出返回箭头、触发返回键、
     * 于是打开了左侧会话列表。这里在根 View 上再申请一条更宽的边缘条，两者叠加提高命中率。
     * 系统对排除区有上限（沿边缘约 200dp），拿不回的那部分由「任意位置都能起手」的手势接住。
     */
    private fun applySystemGestureExclusion() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val root = window.decorView
        if (root.width <= 0 || root.height <= 0) {
            // 首帧布局前尺寸还是 0，等一帧再设
            root.post { applySystemGestureExclusion() }
            return
        }
        val edgePx = (EDGE_EXCLUSION_DP * resources.displayMetrics.density).toInt()
        root.systemGestureExclusionRects =
            listOf(android.graphics.Rect(root.width - edgePx, 0, root.width, root.height))
    }

    private companion object {
        /** 向系统申请的右边缘排除区宽度（dp）；比系统手势区宽一些，给手指留容错。 */
        const val EDGE_EXCLUSION_DP = 32f

        /** 返回手势的触点落在这条比例线以右，就算「右侧侧滑」。 */
        const val RIGHT_SWIPE_START_FRACTION = 0.75f
    }

    /**
     * 把「屏幕右侧的返回手势」当作右侧节点面板的**侧滑**（Android 13+ 预测性返回）。
     *
     * 为什么绕这一圈：屏幕最右那条缝归**系统返回手势**，App 拿不到 touch；
     * `systemGestureExclusionRects` 系统也只接受每边约 200dp 高（官方文档），贴边全高做不到。
     * 而预测性返回的回调恰好给了侧滑需要的两样东西：
     *  - [BackEventCompat.swipeEdge]（Android 14+）→ 手势来自哪一侧（老版本用触点位置兜底）；
     *  - [BackEventCompat.progress] → 手势进度，可直接驱面板跟手。
     *
     * 行为：面板未开时右边缘向内滑 = 拉开；已开时 = 收回去（与系统手势“再滑一次就退一层”一致）。
     * 左侧来源以及其它页面的返回**原地让位**给 Compose 的 BackHandler，行为不变。
     */
    private fun setupRightEdgeBackSwipe() {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                private var fromRight = false
                private var closing = false

                override fun handleOnBackStarted(backEvent: BackEventCompat) {
                    fromRight = false
                    closing = false
                    if (!container.rightSwipeEnabled.value) return
                    fromRight = when (backEvent.swipeEdge) {
                        BackEventCompat.EDGE_RIGHT -> true
                        BackEventCompat.EDGE_LEFT -> false
                        // Android 13 没有 swipeEdge：用触点位置兜底（落在右 1/4 算右侧）
                        else -> {
                            val width = window.decorView.width
                            width > 0 && backEvent.touchX >= width * RIGHT_SWIPE_START_FRACTION
                        }
                    }
                    if (!fromRight) return
                    closing = container.rightPanelOpen.value
                    container.rightPanelSwipe.value = if (closing) 1f else 0f
                }

                override fun handleOnBackProgressed(backEvent: BackEventCompat) {
                    if (!fromRight) return
                    val progress = backEvent.progress.coerceIn(0f, 1f)
                    // 关闭时进度反向：手势往里滑 → 面板往右退
                    container.rightPanelSwipe.value = if (closing) 1f - progress else progress
                }

                override fun handleOnBackPressed() {
                    if (fromRight) {
                        container.rightPanelSwipe.value = null
                        if (closing) container.closeRightPanel.value += 1 else container.openRightPanel.value += 1
                        return
                    }
                    // 不是右侧来源：让位给 Compose 的 BackHandler，处理完再把自己的开关打开
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    window.decorView.post { isEnabled = true }
                }

                override fun handleOnBackCancelled() {
                    // 手势取消：面板退回原状态（开着就回到全开，关着就回到收起）
                    if (fromRight) container.rightPanelSwipe.value = if (closing) 1f else 0f
                }
            },
        )
    }
}
