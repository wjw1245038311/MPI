package com.mpi.app.data

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * 与中继的连接状态。
 *
 * 设计约束（docs/MOBILE-NATIVE-DESIGN.md §1.1/§1.5）：状态必须**对用户可见**，
 * 所以「关闭」与「失败」分开，并保留中继给的关闭码——
 * 4001/4002/4006 分别意味着认证失败 / 被撤销 / 被顶替，处置方式完全不同。
 */
sealed interface RelayState {
    data object Idle : RelayState

    data object Connecting : RelayState

    data object Open : RelayState

    /** 中继主动关闭：见 [RelayClient] 的 CLOSE_* 常量。 */
    data class Closed(val code: Int, val reason: String) : RelayState

    /** 连接失败（网络不可达、TLS 失败等）。 */
    data class Failed(val message: String) : RelayState
}

/**
 * 中继 WebSocket 客户端（ws / wss）。
 *
 * 职责边界：只做「建连 + 收发文本帧」，**不解析业务协议、不做加解密**。
 * 这与中继自身「不透明帧路由」的定位一致（mobile/relay/README.md）。
 * 上层通过 [onFrame] / [onState] 订阅，多个订阅者互不影响。
 *
 * 心跳：OkHttp 的 `pingInterval` 周期发 WebSocket ping 并自动回 pong，
 * 与中继的 RELAY_PING_MS（20s）/ RELAY_DEAD_MS（60s）匹配，无需手写心跳。
 */
class RelayClient(
    private val url: String,
    pingIntervalSeconds: Long = 20,
) {
    private val httpClient = OkHttpClient.Builder()
        .pingInterval(pingIntervalSeconds, TimeUnit.SECONDS)
        .build()

    private val frameListeners = CopyOnWriteArrayList<(String) -> Unit>()
    private val stateListeners = CopyOnWriteArrayList<(RelayState) -> Unit>()

    @Volatile
    private var socket: WebSocket? = null

    @Volatile
    var state: RelayState = RelayState.Idle
        private set

    /** 订阅收到的文本帧（JSON 原文）。返回取消订阅的函数。 */
    fun onFrame(listener: (String) -> Unit): () -> Unit {
        frameListeners += listener
        return { frameListeners -= listener }
    }

    /** 订阅状态变化。返回取消订阅的函数。 */
    fun onState(listener: (RelayState) -> Unit): () -> Unit {
        stateListeners += listener
        return { stateListeners -= listener }
    }

    /** 发起连接；已在连接中/已连接时返回 false。 */
    fun connect(): Boolean {
        if (socket != null) return false
        publishState(RelayState.Connecting)
        val request = Request.Builder().url(url).build()
        socket = httpClient.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    publishState(RelayState.Open)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    frameListeners.forEach { runCatching { it(text) } }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(NORMAL_CLOSURE, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    socket = null
                    publishState(RelayState.Closed(code, reason))
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    socket = null
                    publishState(RelayState.Failed(t.message ?: t::class.java.simpleName))
                }
            },
        )
        return true
    }

    /** 发送一条 JSON 文本帧；返回 false 表示未连接或发送队列已满。 */
    fun send(rawJson: String): Boolean = socket?.send(rawJson) ?: false

    fun close(code: Int = NORMAL_CLOSURE, reason: String? = null) {
        socket?.close(code, reason)
        socket = null
    }

    fun isOpen(): Boolean = socket != null

    private fun publishState(next: RelayState) {
        state = next
        stateListeners.forEach { runCatching { it(next) } }
    }

    companion object {
        const val NORMAL_CLOSURE = 1000

        /** 中继的关闭码（mobile/relay/index.mjs）。 */
        const val CLOSE_AUTH_FAILED = 4001
        const val CLOSE_REVOKED = 4002
        const val CLOSE_TOO_LARGE = 4003
        const val CLOSE_BAD_FIRST_FRAME = 4004
        const val CLOSE_HEARTBEAT_TIMEOUT = 4005
        const val CLOSE_REPLACED = 4006
    }
}
