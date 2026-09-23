package com.mpi.app.ui

import com.mpi.app.data.PairingStage
import com.mpi.app.data.SessionState
import com.mpi.app.protocol.RemoteThreadState

/** 相对时间（对照 PWA 的 relTime）。 */
fun relTime(timestamp: Long, now: Long = System.currentTimeMillis()): String {
    val diff = now - timestamp
    return when {
        diff < 45_000 -> "刚刚"
        diff < 3_600_000 -> "${maxOf(1, (diff / 60_000).toInt())} 分钟前"
        diff < 86_400_000 -> "${(diff / 3_600_000).toInt()} 小时前"
        else -> "${(diff / 86_400_000).toInt()} 天前"
    }
}

fun RemoteThreadState.label(): String = when (this) {
    RemoteThreadState.Draft -> "草稿"
    RemoteThreadState.Idle -> "空闲"
    RemoteThreadState.Running -> "运行中"
    RemoteThreadState.Error -> "出错"
    RemoteThreadState.Disconnected -> "已断开"
    RemoteThreadState.Unknown -> "状态未知"
}

/** 会话状态徽章的字色/底色由 UI 决定，这里只给文案。 */
fun SessionState.label(): String = when (this) {
    SessionState.Disconnected -> "未连接"
    SessionState.Connecting -> "连接中…"
    SessionState.Authenticating -> "认证中…"
    is SessionState.Connected -> "已连接"
    is SessionState.Failed -> detail
}

fun PairingStage.label(): String = when (this) {
    PairingStage.Connecting -> "正在连接中继…"
    PairingStage.WaitingChallenge -> "等待主机挑战…"
    PairingStage.WaitingApproval -> "等待桌面端批准（在 Windows 的「手机远程控制」面板点「允许」）"
    PairingStage.Approved -> "配对成功"
}
