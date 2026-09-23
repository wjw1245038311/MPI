package com.mpi.app.data

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.mpi.app.MainActivity

/**
 * 本地通知（M5）：审批提醒 + 前台服务常驻通知。
 *
 * 设计文档 §8 的范围划分：
 * - v1 只做「通知 → 点击打开 App → 直达审批卡」；
 * - **不做**通知栏就地批准（那要求后台进程持有密钥并跑 E2E 协议，留 v2）。
 */
class Notifier(private val context: Context) {

    private val manager: NotificationManager? =
        context.getSystemService(NotificationManager::class.java)

    init {
        ensureChannels()
    }

    /** 前台服务常驻通知：低打扰、不可划掉（关掉它等于放弃后台连接）。 */
    fun serviceNotification(text: String): Notification =
        NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("MPI")
            .setContentText(text)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setShowWhen(false)
            .setContentIntent(openAppIntent(null))
            .build()

    /** 有会话在等审批：高优先级、点击直达该会话。 */
    fun notifyApproval(threadId: String, threadTitle: String?) {
        val notification = NotificationCompat.Builder(context, CHANNEL_APPROVAL)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("MPI 需要你的确认")
            .setContentText(approvalText(threadTitle))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(threadId))
            .build()
        runCatching { manager?.notify(APPROVAL_NOTIFICATION_ID, notification) }
    }

    fun cancelApproval() {
        runCatching { manager?.cancel(APPROVAL_NOTIFICATION_ID) }
    }

    fun startLinkService() {
        MpiLinkService.start(context)
    }

    fun stopLinkService() {
        MpiLinkService.stop(context)
    }

    private fun openAppIntent(threadId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (threadId != null) putExtra(EXTRA_THREAD_ID, threadId)
        }
        // 不同会话用不同 requestCode，避免 PendingIntent 复用导致深链串台
        return PendingIntent.getActivity(
            context,
            threadId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun ensureChannels() {
        val service = NotificationChannel(CHANNEL_SERVICE, "后台连接", NotificationManager.IMPORTANCE_MIN).apply {
            description = "保持与电脑的连接，以便随时收到审批提醒"
            setShowBadge(false)
        }
        val approval = NotificationChannel(CHANNEL_APPROVAL, "审批提醒", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "有操作需要你批准时提醒"
        }
        runCatching { manager?.createNotificationChannels(listOf(service, approval)) }
    }

    companion object {
        const val CHANNEL_SERVICE = "mpi-service"
        const val CHANNEL_APPROVAL = "mpi-approval"
        const val FOREGROUND_NOTIFICATION_ID = 1001
        const val APPROVAL_NOTIFICATION_ID = 1002
        const val EXTRA_THREAD_ID = "mpi.threadId"

        /** 通知正文（纯函数，可单测）：带会话标题时给上下文，标题过长截断。 */
        internal fun approvalText(threadTitle: String?): String {
            val title = threadTitle?.trim().orEmpty()
            if (title.isEmpty()) return "有会话正在等待批准"
            return "「${title.take(40)}」正在等待批准"
        }
    }
}
