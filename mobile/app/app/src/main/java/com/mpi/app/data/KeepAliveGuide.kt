package com.mpi.app.data

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * 后台保活引导（电池优化白名单 + 国产 ROM 自启动/后台运行）。
 *
 * 为什么需要：Doze / App Standby 会在后台**推迟网络访问**，`PARTIAL_WAKE_LOCK` 也不豁免
 * （2026-09-26 真机实测：拿到 wakelock 仍被中继判 `relay-device-offline`，后台 10 分钟
 * 一次都没重连上）。唯一被官方认可的解法是让用户把 App 加进系统白名单：
 *  - 「忽略电池优化」有标准 API（[requestIgnoreBatteryOptimization]）；
 *  - 「自启动 / 后台运行 / 省电策略」各家 ROM 各写各的，只能用厂商设置页直达 + 兜底文案。
 *
 * 诚实标注：白名单也不保证 100%（部分 ROM 仍会激进清理），所以调用方还要配合
 * 「网络恢复 / 回前台立即重连」（[NetworkWatcher] 与 MpiApp 的前后台 kick）。
 */
object KeepAliveGuide {

    enum class Vendor(val label: String) {
        XIAOMI("小米 / 红米 / POCO"),
        HUAWEI("华为 / 荣耀"),
        OPPO("OPPO / realme"),
        VIVO("vivo / iQOO"),
        MEIZU("魅族"),
        ONEPLUS("一加"),
        LETV("乐视"),
        OTHER(""),
    }

    /** 厂商归一化（纯函数，便于单测）：manufacturer/brand 任一命中即算。 */
    fun vendorOf(manufacturer: String?, brand: String?): Vendor {
        val key = "${manufacturer.orEmpty()} ${brand.orEmpty()}".lowercase()
        return when {
            key.contains("xiaomi") || key.contains("redmi") || key.contains("poco") -> Vendor.XIAOMI
            key.contains("huawei") || key.contains("honor") -> Vendor.HUAWEI
            key.contains("oneplus") -> Vendor.ONEPLUS
            key.contains("oppo") || key.contains("realme") -> Vendor.OPPO
            key.contains("vivo") || key.contains("iqoo") -> Vendor.VIVO
            key.contains("meizu") -> Vendor.MEIZU
            key.contains("letv") || key.contains("leeco") -> Vendor.LETV
            else -> Vendor.OTHER
        }
    }

    fun currentVendor(): Vendor = vendorOf(Build.MANUFACTURER, Build.BRAND)

    /**
     * 厂商「自启动 / 后台运行」设置页候选（`pkg/cls`，纯函数）。
     *
     * 顺序即尝试顺序；同一 ROM 换代常换 Activity，所以给多个候选，全部打不开就回落
     * 到应用详情页。空列表 = 没有已知入口（走通用兜底）。
     */
    fun vendorSettingCandidates(vendor: Vendor): List<String> = when (vendor) {
        Vendor.XIAOMI -> listOf(
            "com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity",
        )

        Vendor.HUAWEI -> listOf(
            "com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager/.appcontrol.activity.StartupAppControlActivity",
        )

        Vendor.OPPO -> listOf(
            "com.coloros.safecenter/.permission.startup.StartupAppListActivity",
            "com.oppo.safe/.permission.startup.StartupAppListActivity",
        )

        Vendor.VIVO -> listOf(
            "com.vivo.permissionmanager/.activity.BgStartUpManagerActivity",
            "com.iqoo.secure/.ui.phoneoptimize.AddWhiteListActivity",
        )

        Vendor.MEIZU -> listOf(
            "com.meizu.safe/.permission.SmartBGActivity",
            "com.meizu.safe/.permission.PermissionMainActivity",
        )

        Vendor.ONEPLUS -> listOf(
            "com.oneplus.security/.chainlaunch.view.ChainLaunchAppListActivity",
        )

        Vendor.LETV -> listOf(
            "com.letv.android.letvsafe/.AutobootManageActivity",
        )

        Vendor.OTHER -> emptyList()
    }

    /** 是否已被系统豁免电池优化（查不到时按「已允许」处理——不打扰用户）。 */
    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        val pm = context.applicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
            ?: return true
        return runCatching { pm.isIgnoringBatteryOptimizations(context.packageName) }.getOrDefault(true)
    }

    /** 直接请求「忽略电池优化」（需 Manifest 的 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS）。 */
    @SuppressLint("BatteryLife")
    fun requestIgnoreBatteryOptimization(context: Context): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** 电池优化列表页（直接请求弹窗不可用时的兜底）。 */
    fun batteryOptimizationSettings(): Intent =
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** 本应用详情页——自启动 / 后台运行 / 省电策略的通用入口。 */
    fun appDetailsSettings(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * 逐个尝试厂商设置页；返回是否有一个真的打开了。
     *
     * 不做 `resolveActivity` 预检：Android 11+ 的包可见性会让它误报 null（候选包没在
     * `<queries>` 里），反而不如直接 startActivity + 捕获 `ActivityNotFoundException`。
     */
    fun openVendorSettings(context: Context): Boolean {
        for (spec in vendorSettingCandidates(currentVendor())) {
            val parts = spec.split("/")
            if (parts.size != 2) continue
            val pkg = parts[0]
            val cls = if (parts[1].startsWith(".")) pkg + parts[1] else parts[1]
            val intent = Intent().setClassName(pkg, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { context.startActivity(intent) }.isSuccess) return true
        }
        return false
    }
}
