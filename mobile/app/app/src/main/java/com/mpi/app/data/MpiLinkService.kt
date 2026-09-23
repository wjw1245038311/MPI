package com.mpi.app.data

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat

/**
 * 前台服务：**只负责保活**——让进程在后台不被系统回收，从而让 UI 层的连接与
 * 事件监听继续活着（收到审批才能弹通知）。
 *
 * 为什么不把网络与 E2E 解密搬进来（设计文档 §8 / §8.1）：
 * 那会让密钥进入无 UI 的后台进程，安全面与复杂度都上一个台阶；v1 明确不做
 * 「通知栏就地批准」，因此也不需要后台跑协议。留待 v2 单独评估。
 *
 * 局限（诚实标注）：用户在最近任务里划掉 App 时进程仍可能被回收，此时连接会断，
 * 直到下次打开 App 自愈重连。
 */
class MpiLinkService : Service() {

    override fun onCreate() {
        super.onCreate()
        val notification = Notifier(this).serviceNotification("正在保持与电脑的连接")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                Notifier.FOREGROUND_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(Notifier.FOREGROUND_NOTIFICATION_ID, notification)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        fun start(context: Context) {
            runCatching {
                ContextCompat.startForegroundService(context, Intent(context, MpiLinkService::class.java))
            }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, MpiLinkService::class.java)) }
        }
    }
}
