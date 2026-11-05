package com.mpi.app

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 崩溃取证 + 安全模式。
 *
 * 为什么需要（2026-11-06 真机）：手机端「闪退后完全无法进入 App」，而安卓默认崩溃只弹一个
 * 系统对话框、进程就没了——既没有 logcat 也没有文件，等于**没有任何证据**。这个类做三件事：
 *
 * 1. **装全局未捕获异常处理器**：把崩溃的线程名、异常类型、栈、版本号写进
 *    `filesDir/crash/last-crash.txt`，然后照旧交给系统默认处理器（行为不变，只是多留一份）；
 * 2. **记协程里的「非致命」异常**：`AppContainer.scope` 挂了
 *    `CoroutineExceptionHandler`，throw 出来的东西不再静默吞掉，写进
 *    `recent-errors.txt`（滚动、限频）；
 * 3. **安全模式**：启动时先置「启动中」标记，初始化跑完才清。如果标记还在、又留下了崩溃
 *    记录，说明**上次是在启动/自动重连阶段死的** —— 这次就不自动连上次的主机，
 *    保证 App 至少能进得去（真机诉求：「完全无法进入 App」）。
 *
 * 只写应用私有目录，不含任何会话内容、密钥或凭证。
 */
object CrashLog {

    private const val PREFS = "mpi-crash"
    private const val KEY_STARTUP = "startup_in_progress"
    private const val KEY_SAFE_MODE = "safe_mode"
    private const val DIR = "crash"
    private const val FILE_LAST = "last-crash.txt"
    private const val FILE_RECENT = "recent-errors.txt"
    /** 单个文件上限：崩溃栈一般几 KB，留 64KB 足够，且避免把存储写满。 */
    private const val MAX_BYTES = 64L * 1024

    @Volatile
    private var appContext: Context? = null

    /** 非致命异常的限频（同一时刻只记一条，避免异常风暴把存储写爆）。 */
    @Volatile
    private var lastNonFatalAt = 0L
    private const val NON_FATAL_MIN_INTERVAL_MS = 3_000L

    private fun stamp(): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())

    /** 装全局处理器。必须在 `Application.onCreate` 里最早调用。 */
    fun install(context: Context) {
        appContext = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { writeLastCrash(error, thread) }
            // 保持系统原有行为（ANR/崩溃弹窗、进程结束），这里只是「顺手留证据」
            previous?.uncaughtException(thread, error)
        }
    }

    // ---- 写 ----

    /** 致命崩溃：写 last-crash.txt（并置安全模式标记，见 [beginStartup]）。 */
    private fun writeLastCrash(error: Throwable, thread: Thread?) {
        val context = appContext ?: return
        val details = buildString {
            appendLine("时间：${stamp()}")
            appendLine("版本：${appVersion(context)}")
            appendLine("设备：${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} / Android ${android.os.Build.VERSION.RELEASE} (SDK ${android.os.Build.VERSION.SDK_INT})")
            appendLine("线程：${thread?.name ?: "?"}")
            appendLine("异常：${error.javaClass.name}")
            appendLine("启动阶段：${if (isStartupInProgress(context)) "是（初始化未完成）" else "否"}")
            appendLine()
            appendLine(readableStack(error))
        }
        runCatching { file(context, FILE_LAST).writeText(details.take(64 * 1024)) }
    }

    /**
     * 非致命异常（协程里逃出来的）。限频写 recent-errors.txt，供排查用；
     * 绝不影响主流程。
     */
    fun recordNonFatal(error: Throwable) {
        val now = System.currentTimeMillis()
        if (now - lastNonFatalAt < NON_FATAL_MIN_INTERVAL_MS) return
        lastNonFatalAt = now
        val context = appContext ?: return
        val line = buildString {
            appendLine("[${
                SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date(now))
            }] ${appVersion(context)} ${error.javaClass.simpleName}: ${error.message}")
            appendLine(readableStack(error).lineSequence().take(12).joinToString("\n"))
            appendLine()
        }
        runCatching {
            val target = file(context, FILE_RECENT)
            val existing = if (target.exists()) target.readText().takeLast(MAX_BYTES.toInt() - 8 * 1024) else ""
            target.writeText(existing + line)
        }
    }

    private fun readableStack(error: Throwable): String =
        runCatching {
            val writer = StringWriter()
            error.printStackTrace(PrintWriter(writer))
            writer.toString()
        }.getOrDefault("${error.javaClass.name}: ${error.message}")

    private fun file(context: Context, name: String): File {
        val dir = File(context.filesDir, DIR).apply { mkdirs() }
        return File(dir, name)
    }

    private fun appVersion(context: Context): String = runCatching {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        "${info.versionName}（${info.versionCode}）"
    }.getOrDefault("?")

    // ---- 读 / 清 ----

    /** 上一次崩溃的完整记录（null = 没有）。 */
    fun lastCrash(): String? {
        val context = appContext ?: return null
        val target = file(context, FILE_LAST)
        if (!target.exists()) return null
        return runCatching { target.readText().ifBlank { null } }.getOrNull()
    }

    /** 非致命异常的滚动记录（诊断页/崩溃页「一起复制」用）。 */
    fun recentErrors(): String? {
        val context = appContext ?: return null
        val target = file(context, FILE_RECENT)
        if (!target.exists()) return null
        return runCatching { target.readText().ifBlank { null } }.getOrNull()
    }

    /** 用户已经看过/处理过这次崩溃：删掉，下次启动不再挡路。 */
    fun clearLastCrash() {
        val context = appContext ?: return
        runCatching { file(context, FILE_LAST).delete() }
        runCatching { file(context, FILE_RECENT).delete() }
    }

    // ---- 启动标记与安全模式 ----

    /**
     * 启动开始（`Application.onCreate`）。标记会一直留到 [finishStartup]——
     * 中途进程没了就说明「上次是在启动阶段死的」。
     */
    fun beginStartup() {
        val context = appContext ?: return
        runCatching {
            prefs(context).edit().putBoolean(KEY_STARTUP, true).apply()
        }
    }

    /** 初始化跑完（无论成功失败）：清标记。 */
    fun finishStartup() {
        val context = appContext ?: return
        runCatching { prefs(context).edit().putBoolean(KEY_STARTUP, false).apply() }
    }

    private fun isStartupInProgress(context: Context): Boolean =
        runCatching { prefs(context).getBoolean(KEY_STARTUP, false) }.getOrDefault(false)

    /**
     * 这次要不要进安全模式：**上次启动标记还没清，且确实留下了崩溃记录**。
     *
     * 只用「标记没清」判断会误判（用户从最近任务划掉进程也是这个状态）——所以加上
     * 「有崩溃文件」这一条；正常被杀不会写崩溃文件（见 [install]）。
     */
    fun shouldEnterSafeMode(): Boolean {
        val context = appContext ?: return false
        val crashedDuringStartup = isStartupInProgress(context) && file(context, FILE_LAST).exists()
        if (crashedDuringStartup) {
            runCatching { prefs(context).edit().putBoolean(KEY_SAFE_MODE, true).apply() }
        }
        return crashedDuringStartup || runCatching { prefs(context).getBoolean(KEY_SAFE_MODE, false) }.getOrDefault(false)
    }

    /** 用户已经在安全模式里成功进过一次：清掉安全模式，恢复正常启动路径。 */
    fun clearSafeMode() {
        val context = appContext ?: return
        runCatching { prefs(context).edit().putBoolean(KEY_SAFE_MODE, false).apply() }
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
