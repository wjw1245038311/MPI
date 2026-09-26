package com.mpi.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 网络恢复监听：可用网络出现时立刻通知上层重连。
 *
 * 为什么需要（2026-09-26 真机）：后台被系统掐网后，重连按退避走（最长 30s）；用户回
 * 前台时 MpiApp 会 kick 一次，于是表现成「必须打开 App 才连得上」。但在「系统恢复网络」
 * （Doze 维护窗口 / 重新亮屏 / 切回 Wi-Fi）这条路径上原本没人叫醒重连——本类补上它，
 * 与前后台 kick 并列。
 *
 * 语义：只报「有默认网络可用」，不判重连是否必要——[HostSession.kick] 自己会在已连上时
 * 直接返回，重复触发是安全的。
 */
class NetworkWatcher(context: Context) {

    private val manager: ConnectivityManager? =
        context.applicationContext.getSystemService(ConnectivityManager::class.java)

    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            listeners.forEach { runCatching { it() } }
        }
    }

    private var registered = false

    /** 注册回调（幂等）；返回取消订阅的函数。 */
    fun addListener(listener: () -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }

    /** 开始监听默认网络变化（幂等，失败静默——保活引导绝不拖累主流程）。 */
    fun start() {
        if (registered) return
        val ok = runCatching {
            manager?.registerDefaultNetworkCallback(callback)
        }.isSuccess
        registered = ok && manager != null
    }

    fun stop() {
        if (!registered) return
        runCatching { manager?.unregisterNetworkCallback(callback) }
        registered = false
    }
}
