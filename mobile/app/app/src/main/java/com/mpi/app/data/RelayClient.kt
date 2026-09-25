package com.mpi.app.data

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
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

    /** 中继主动关闭：见 [RelayClient] 的 CLOSE_* 常量。
     *
     * `expected = true` 表示这是**本端主动放弃**这条 socket（kick 重建 / 停止），
     * 不是故障——上层不要当作「中继断线」上报，只需要决定要不要重建连接
     * （`HostSession.onClosed` 里走 `ensureConnected()`）。 */
    data class Closed(val code: Int, val reason: String, val expected: Boolean = false) : RelayState

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
 *
 * **并发/世代约束（2026-09-26 真机事故）**：每次 [connect]/[close] 都自增一个世代号，
 * 回调里世代不匹配 = 事件属于已被放弃的旧 socket，必须整条丢弃。缺这层防护时，
 * 「旧 socket 的 close 回调把新 socket 引用清掉」「旧 socket 迟到收到中继的 replaced
 * 帧被当前会话当成自己的」会同时发生：App 反复顶替自己、被判 `Replaced` 后永久停死
 * （中继日志指纹：同一 deviceId 每几秒一轮 `hello ok` + `REPLACED` + `gone (code=1000)`）。
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

    /** 当前 socket 的世代号；[connect]/[close] 各自增一次，旧 socket 的回调据此失效。 */
    private val generation = AtomicLong()

    @Volatile
    private var socket: WebSocket? = null

    /** 当前 socket 是否已经握手完成（收到过 onOpen）。 */
    @Volatile
    private var opened = false

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

    /** 发起连接；已有 socket（含握手中）时返回 false。 */
    fun connect(): Boolean {
        if (socket != null) return false
        val gen = generation.incrementAndGet()
        opened = false
        publishState(RelayState.Connecting)
        val request = Request.Builder().url(url).build()
        socket = httpClient.newWebSocket(
            request,
            object : WebSocketListener() {
                /** 本回调是否属于当前这条 socket（旧 socket 的事件一律丢弃）。 */
                private fun isCurrent(): Boolean = generation.get() == gen

                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (!isCurrent()) return
                    opened = true
                    publishState(RelayState.Open)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (!isCurrent()) return
                    frameListeners.forEach { runCatching { it(text) } }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    if (!isCurrent()) return
                    webSocket.close(NORMAL_CLOSURE, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (!isCurrent()) return
                    socket = null
                    opened = false
                    publishState(RelayState.Closed(code, reason))
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (!isCurrent()) return
                    socket = null
                    opened = false
                    publishState(RelayState.Failed(t.message ?: t::class.java.simpleName))
                }
            },
        )
        return true
    }

    /** 发送一条 JSON 文本帧；返回 false 表示未连接或发送队列已满。 */
    fun send(rawJson: String): Boolean = socket?.send(rawJson) ?: false

    /**
     * 主动放弃当前 socket（kick 重建 / 停止 / 换设备）。
     *
     * 清引用并发 close 帧，然后广播一条 `expected = true` 的 [RelayState.Closed]——
     * 这是「本端决定重来」，不是「中继断线」。旧 socket 之后的一切回调（onMessage /
     * onClosed / onFailure）都因世代不匹配被忽略，**不可能再污染新建的连接**。
     */
    fun close(code: Int = NORMAL_CLOSURE, reason: String? = null) {
        val ws = socket
        generation.incrementAndGet()
        socket = null
        opened = false
        if (ws != null) runCatching { ws.close(code, reason) }
        publishState(RelayState.Closed(code, reason ?: "", expected = true))
    }

    /** 通道是否真的可用（已握手完成且未被放弃）。 */
    fun isOpen(): Boolean = socket != null && opened

    /** 是否存在一条尚未结束的 socket（含握手中）——用于决定「重连还是等它」。 */
    fun hasLiveSocket(): Boolean = socket != null

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
