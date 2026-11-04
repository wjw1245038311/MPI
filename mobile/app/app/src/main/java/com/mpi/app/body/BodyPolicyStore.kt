package com.mpi.app.body

import android.content.Context
import android.view.accessibility.AccessibilityNodeInfo
import com.mpi.app.body.proto.Box
import com.mpi.app.body.proto.ConfirmMode
import com.mpi.app.body.proto.FormattedScreen
import com.mpi.app.body.proto.SafetyGate
import com.mpi.app.body.proto.SafetyPolicy
import com.mpi.app.body.proto.Unlocks

/**
 * 安全策略的落地存储（**只有身体层读它**）。
 *
 * 默认值刻意保守：确认模式 `ASK`、解锁全关、支付类应用在不碰名单里。
 * 调试期想跑通「点按」需要把确认模式改成 `NEVER`（调试页提供开关），
 * 这是显式动作，不是默认路径。
 */
class BodyPolicyStore(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    fun confirmMode(): ConfirmMode = when (prefs.getString(KEY_MODE, null)) {
        ConfirmMode.NEVER.name -> ConfirmMode.NEVER
        ConfirmMode.TASK_ONCE.name -> ConfirmMode.TASK_ONCE
        else -> ConfirmMode.ASK
    }

    fun setConfirmMode(mode: ConfirmMode) {
        prefs.edit().putString(KEY_MODE, mode.name).apply()
    }

    fun unlocks(): Unlocks = Unlocks(
        systemPages = prefs.getBoolean(KEY_UNLOCK_SYSTEM, false),
        secretFields = prefs.getBoolean(KEY_UNLOCK_SECRET, false),
        ownApp = prefs.getBoolean(KEY_UNLOCK_OWN, false),
    )

    /** 桌面能否驱动这台手机（默认关，设计文档 §3.5）。 */
    fun allowRemoteDriving(): Boolean = prefs.getBoolean(KEY_ALLOW_REMOTE, false)

    fun setAllowRemoteDriving(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_ALLOW_REMOTE, enabled).apply()
    }

    fun setUnlock(kind: String, enabled: Boolean) {
        val key = when (kind) {
            "systemPages" -> KEY_UNLOCK_SYSTEM
            "secretFields" -> KEY_UNLOCK_SECRET
            "ownApp" -> KEY_UNLOCK_OWN
            else -> return
        }
        prefs.edit().putBoolean(key, enabled).apply()
    }

    fun policy(): SafetyPolicy = SafetyPolicy(
        denyPackages = SafetyGate.DEFAULT_DENY,
        // 通讯类默认「每一步都确认」——发错消息的代价比多点一次高
        confirmEveryWritePackages = listOf("com.tencent.mm"),
        confirmMode = confirmMode(),
        unlocks = unlocks(),
    )

    private companion object {
        const val PREF = "mpi_body_policy"
        const val KEY_MODE = "confirmMode"
        const val KEY_UNLOCK_SYSTEM = "unlock.systemPages"
        const val KEY_UNLOCK_SECRET = "unlock.secretFields"
        const val KEY_UNLOCK_OWN = "unlock.ownApp"
        const val KEY_ALLOW_REMOTE = "allowRemoteDriving"
    }
}

/** 无障碍服务对外暴露的最小能力（调度器只认这个接口，方便以后换实现/单测替身）。 */
interface BodyDevice {
    val ownPackage: String
    val screenWidth: Int
    val screenHeight: Int

    /** 当前所有窗口的根节点（top-most 在前）。 */
    fun roots(): List<AccessibilityNodeInfo>

    /** 前台应用的包名（读不到就 null）。 */
    fun foregroundPackage(): String?

    /** 键盘是否弹出；读不到时 null。 */
    fun keyboardShown(): Boolean?

    fun actuator(): Actuator?

    /** 前台应用的显示名（能读就读，读不到 null）。 */
    fun appLabel(pkg: String?): String?

    fun stopAll(reason: String)
}

/** 一次采集的结果（调度器用它返回给客户端）。 */
class ScreenSnapshot(
    val screenId: String,
    val formatted: FormattedScreen,
    val packageName: String?,
    val appLabel: String?,
)

internal fun Box.toJson(): Map<String, Int> =
    linkedMapOf("left" to left, "top" to top, "right" to right, "bottom" to bottom)
