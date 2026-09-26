package com.mpi.app.data

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
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

    /** 「回复完成」通知目前属于哪条会话（null = 没挂着）；用于「打开该会话才清」。 */
    private var turnThreadId: String? = null

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

    /**
     * 手机发起的回合在后台跑完：普通优先级、点击直达该会话。
     *
     * 只由 AppViewModel 在「设置开着 + 不在前台 + 本回合是手机发起」时调用
     * （判定见 [shouldNotifyTurnComplete]）——前台盯着屏幕时不打扰。
     */
    fun notifyTurnComplete(threadId: String, threadTitle: String?, body: String) {
        turnThreadId = threadId
        val notification = NotificationCompat.Builder(context, CHANNEL_TURN)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(turnCompleteTitle(threadTitle))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(threadId))
            .build()
        runCatching { manager?.notify(TURN_NOTIFICATION_ID, notification) }
    }

    /**
     * 清除「回复完成」通知。
     *
     * @param threadId 传了就**只在该会话匹配时**清——由 [AppViewModel.openThread] 调用：
     *   回到 App 但看的是别的会话时不该清（用户确认的时机）。不传则无条件清。
     */
    fun cancelTurnComplete(threadId: String? = null) {
        if (threadId != null && threadId != turnThreadId) return
        turnThreadId = null
        runCatching { manager?.cancel(TURN_NOTIFICATION_ID) }
    }

    /**
     * 诊断用：发一条与「对话完成」**同渠道**的测试通知。
     *
     * 延迟交给调用方控制（AppViewModel.testNotification 会等十几秒）——只有给用户时间
     * 切到后台 / 熄屏，测的才是「后台能不能弹」，而不是「前台能不能弹」。
     */
    fun notifyTest(body: String) = notifyTurnComplete("", "测试通知", body)

    /** 诊断用：通知总开关 + 「对话完成」渠道状态（收不到通知最常见的两个原因）。 */
    fun diagnostics(): String {
        val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val channel = manager?.getNotificationChannel(CHANNEL_TURN)
        val channelState = when {
            channel == null -> "「对话完成」渠道缺失"
            channel.importance == NotificationManager.IMPORTANCE_NONE -> "「对话完成」渠道被关"
            else -> "「对话完成」渠道正常"
        }
        return if (enabled) "系统通知已开启 · $channelState" else "系统通知被关闭（设置 → 应用 → MPI → 通知）"
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
        val turn = NotificationChannel(CHANNEL_TURN, "对话完成", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "手机发起的对话在后台跑完时提醒"
        }
        runCatching { manager?.createNotificationChannels(listOf(service, approval, turn)) }
    }

    companion object {
        const val CHANNEL_SERVICE = "mpi-service"
        const val CHANNEL_APPROVAL = "mpi-approval"
        const val CHANNEL_TURN = "mpi-turn"
        const val FOREGROUND_NOTIFICATION_ID = 1001
        const val APPROVAL_NOTIFICATION_ID = 1002
        const val TURN_NOTIFICATION_ID = 1003
        const val EXTRA_THREAD_ID = "mpi.threadId"

        /** 通知正文（纯函数，可单测）：带会话标题时给上下文，标题过长截断。 */
        internal fun approvalText(threadTitle: String?): String {
            val title = threadTitle?.trim().orEmpty()
            if (title.isEmpty()) return "有会话正在等待批准"
            return "「${title.take(40)}」正在等待批准"
        }

        /** 完成通知标题（纯函数，可单测）。 */
        internal fun turnCompleteTitle(threadTitle: String?): String {
            val title = threadTitle?.trim().orEmpty()
            return if (title.isEmpty()) "MPI 回复已完成" else "「${title.take(40)}」回复已完成"
        }

        /**
         * 完成通知正文（纯函数，可单测）：出错优先报错（失败更需要知道），
         * 否则给回复摘要；都没有就兑底一句。换行压成空格，长文本截断。
         */
        internal fun turnCompleteText(reply: String?, error: String? = null): String {
            val failure = flatten(error)
            if (failure.isNotEmpty()) return "出错：${clip(failure)}"
            val text = flatten(reply)
            return if (text.isEmpty()) "回复已完成" else clip(text)
        }

        /**
         * 该不该发「对话完成」通知（纯函数，可单测）。
         *
         * 两个条件：设置开着、**用户没有正在看这个会话**。
         *
         * ⚠️ **不再限制「谁发起的回合」**（原来是「手机发起的才通知」）：用户口径是
         * 「参照飞书已读——只要我没看着，就该通知我」。电脑端发起的回合跑完了，
         * 手机上正干别的，同样应该被叫一下；反过来正在看这个会话时就不叫。
         */
        internal fun shouldNotifyTurnComplete(
            enabled: Boolean,
            watchingThread: Boolean,
        ): Boolean = enabled && !watchingThread

        /** 播报里回复摘要最多念多少字——再长就只剩吵了。 */
        private const val SPEECH_MAX = 60

        /** ``` 围栏代码块：念出来毫无意义（会是「反引号反引号反引号…」）。 */
        private val FENCED_CODE = Regex("```[\\s\\S]*?```")

        /**
         * 要念出来的回复正文（纯函数，可单测）：去掉 ``` 围栏代码块、压平空白、截短。
         * 语音模式的连续对话与「播报内容=回复摘要」都用它，口径一致。
         */
        internal fun spokenReply(reply: String?, max: Int): String {
            val spoken = flatten(reply?.replace(FENCED_CODE, " "))
            if (spoken.isEmpty()) return ""
            return if (spoken.length <= max) spoken else "${spoken.take(max - 1)}…"
        }

        /**
         * 语音播报稿（纯函数，可单测）：按设置念**固定语**或**回复摘要**。
         *
         * 摘要先去掉代码围栏、压平空白、截短——念出来才像人话；摘要为空时退回固定语。
         */
        internal fun turnCompleteSpeech(
            content: VoiceSpeechContent,
            threadTitle: String?,
            reply: String?,
        ): String {
            val title = threadTitle?.trim().orEmpty()
            val prefix = if (title.isEmpty()) "" else "「${title.take(40)}」"
            val fixed = if (prefix.isEmpty()) "回复已完成" else "$prefix 回复已完成"
            if (content == VoiceSpeechContent.Fixed) return fixed
            val excerpt = spokenReply(reply, SPEECH_MAX)
            if (excerpt.isEmpty()) return fixed
            return if (prefix.isEmpty()) excerpt else "$prefix $excerpt"
        }

        private fun flatten(value: String?): String = value?.replace(Regex("\\s+"), " ")?.trim().orEmpty()

        private fun clip(text: String): String = if (text.length <= 80) text else "${text.take(79)}…"
    }
}
