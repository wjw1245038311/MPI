package com.mpi.app.body

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo

/**
 * 身体层的唯一入口：无障碍服务（跑在 `:body` 进程）。
 *
 * 它**自己不读任何东西**——只有工具调用时才采集（设计文档 §2 的生命期约定）。
 * 熄屏 / 系统打断 / 解绑 → 立刻停掉所有任务并通知客户端。
 */
class MpiA11yService : AccessibilityService(), BodyDevice {

    private var actuator: Actuator? = null
    private var screenOffRegistered = false

    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_SCREEN_OFF) stopAll("屏幕关闭了")
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        // 只读窗口内容 + 能注入手势；事件类型由 xml 声明
        serviceInfo = (serviceInfo ?: AccessibilityServiceInfo()).apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
        }
        actuator = Actuator(this)
        BodyHub.attach(this)
        runCatching {
            val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(screenOff, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(screenOff, filter)
            }
            screenOffRegistered = true
        }.onFailure { Log.w(TAG, "screen-off receiver", it) }
        Log.i(TAG, "无障碍服务已连接")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() {
        stopAll("无障碍服务被系统打断")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        teardown("无障碍服务已关闭")
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        teardown("无障碍服务已停止")
        super.onDestroy()
    }

    private fun teardown(reason: String) {
        runCatching { if (screenOffRegistered) unregisterReceiver(screenOff) }
        screenOffRegistered = false
        stopAll(reason)
        actuator?.close()
        actuator = null
        BodyHub.detach(reason)
        Log.i(TAG, "无障碍服务断开：$reason")
    }

    // ---- BodyDevice ----

    override val ownPackage: String get() = packageName

    override val screenWidth: Int get() = resources.displayMetrics.widthPixels

    override val screenHeight: Int get() = resources.displayMetrics.heightPixels

    override fun roots(): List<AccessibilityNodeInfo> {        // 先试窗口列表（能拿到弹窗/系统窗口），退化到 activeWindow + rootInActiveWindow
        val fromWindows = runCatching {
            windows.mapNotNull { runCatching { it.root }.getOrNull() }
        }.getOrDefault(emptyList())
        if (fromWindows.isNotEmpty()) return fromWindows
        return listOfNotNull(runCatching { rootInActiveWindow }.getOrNull())
    }

    override fun foregroundPackage(): String? {
        val active = runCatching {
            windows.firstOrNull { it.isActive }?.root?.packageName?.toString()
        }.getOrNull()
        if (!active.isNullOrEmpty()) return active
        // 退化：窗口列表里第一个应用窗口
        return runCatching {
            windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
                ?.root?.packageName?.toString()
        }.getOrNull()
    }

    override fun appLabel(pkg: String?): String? {
        if (pkg.isNullOrEmpty()) return null
        return runCatching {
            val info = packageManager.getApplicationInfo(pkg, 0)
            packageManager.getApplicationLabel(info).toString()
        }.getOrNull()
    }

    override fun keyboardShown(): Boolean? = runCatching {
        windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
    }.getOrNull()

    override fun actuator(): Actuator? = actuator

    override fun stopAll(reason: String) {
        BodyHub.offerStop(reason)
    }

    companion object {
        private const val TAG = "MpiBodyA11y"

        /** 用户在系统设置里打开了吗（可能还没绑定）。 */
        fun isEnabled(context: Context): Boolean {
            val list = runCatching {
                android.provider.Settings.Secure.getString(
                    context.contentResolver,
                    android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                )
            }.getOrNull() ?: return false
            val me = "${context.packageName}/${MpiA11yService::class.java.name}"
            return list.split(':').any { it.trim().equals(me, ignoreCase = true) }
        }
    }
}
