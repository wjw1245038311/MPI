package com.mpi.app.data

import com.mpi.app.protocol.DeviceIdentity
import com.mpi.app.protocol.E2EFrame
import com.mpi.app.protocol.Envelope
import com.mpi.app.protocol.RemoteEnvelope
import com.mpi.app.protocol.decryptFrame
import com.mpi.app.protocol.encryptFrame
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * 会话失败原因。**每种都对应一条明确的用户文案与可操作项**（§1.1「不静默失败」）：
 *
 * | 原因 | 用户可见文案方向 | 可操作 |
 * | --- | --- | --- |
 * | [AuthFailed] | 「设备令牌已失效」 | 重新配对 |
 * | [Revoked] | 「桌面端已移除本设备」 | 重新配对 |
 * | [Replaced] | 「本设备已在别处连接」 | 重新连接 |
 * | [RelayError] | 中继返回的错误码 | 重试 |
 * | [Network] | 「无法连接中继」 | 重试（会自动重试） |
 * | [Protocol] | 帧格式/解密异常 | 重试；持续失败则重新配对 |
 *
 * 前三者是**终止性**的：不会自动重试（重试也不会成功，只会掩盖问题）。
 */
enum class SessionFailure {
    AuthFailed,
    Revoked,
    Replaced,
    RelayError,
    Network,
    Protocol,
    ;

    /** 终止性失败：不自动重连，必须用户介入（重新配对）。 */
    val isTerminal: Boolean
        get() = this == AuthFailed || this == Revoked || this == Replaced
}

sealed interface SessionState {
    data object Disconnected : SessionState

    data object Connecting : SessionState

    /** 已连上中继，正在走 hello + 挑战应答。 */
    data object Authenticating : SessionState

    data class Connected(val hostId: String) : SessionState

    data class Failed(val reason: SessionFailure, val detail: String) : SessionState
}

/**
 * 主机会话（M1-2）：连中继 → 重认证 → 建立 E2E 收发通道 → 断线自动重连。
 *
 * 分层：本类只管「一条到主机的加密通道」；请求/响应配对在 [Requester]，
 * 业务数据在更上层。
 *
 * **事件发布方式**：入站 envelope 与「非致命问题」都用**同步注册的回调**，
 * 而不是 `SharedFlow`——因为 [Requester] 必须先注册等待者、再发请求，
 * 而 SharedFlow 的订阅是异步的（M1-2 已因此丢过帧）。UI 层需要 Flow 时，
 * 在自己的 ViewModel 里做一次适配即可。
 *
 * 重连语义（对齐 PWA 的 attachAutoReauth）：
 * - 每次 socket 打开都重走一次挑战应答——中继重启后路由会丢，必须重新 hello；
 * - 会话密钥由静态身份确定性派生，所以重连**不需要重新协商**（§4.2）；
 * - 终止性失败（令牌失效/被撤销/被顶替）**不重试**，直接把原因交给 UI。
 */
class HostSession(
    private val client: RelayClient,
    private val record: PairingRecord,
    private val identity: DeviceIdentity,
    private val deviceName: String,
    private val scope: CoroutineScope,
    private val backoffMs: List<Long> = DEFAULT_BACKOFF,
) : RequestTransport {

    private val _state = MutableStateFlow<SessionState>(SessionState.Disconnected)
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private val envelopeListeners = CopyOnWriteArrayList<(RemoteEnvelope) -> Unit>()
    private val problemListeners = CopyOnWriteArrayList<(String) -> Unit>()

    @Volatile
    private var aesKey: ByteArray? = null

    private var authJob: Job? = null
    private var reconnectJob: Job? = null
    private var attempt = 0

    /** 认证连续失败次数：网络抖动很常见，不能一次就判「需要重新配对」。 */
    private var authAttempts = 0
    private var stopped = false

    private val unsubscribeFrame = client.onFrame { raw -> handleFrame(raw) }

    private val unsubscribeState = client.onState { relayState -> handleRelayState(relayState) }

    /** 订阅解密后的入站 envelope。**同步注册**，返回取消订阅的函数。 */
    override fun onEnvelope(listener: (RemoteEnvelope) -> Unit): () -> Unit {
        envelopeListeners += listener
        return { envelopeListeners -= listener }
    }

    /**
     * 订阅「不需要中断会话、但用户/开发者应当知道的问题」（解密失败、意外明文帧等）。
     * 单独一条通道而不是混进 [state]，避免每次小问题都让界面闪一下错误态。
     */
    fun onProblem(listener: (String) -> Unit): () -> Unit {
        problemListeners += listener
        return { problemListeners -= listener }
    }

    /** 建立连接；后续断线由内部自动重连（除非是终止性失败）。 */
    fun connect() {
        stopped = false
        if (client.isOpen()) {
            startAuthentication()
            return
        }
        attempt = 0
        client.connect()
    }

    /** 主动断开并停止重连。 */
    fun stop() {
        stopped = true
        reconnectJob?.cancel()
        authJob?.cancel()
        unsubscribeFrame()
        unsubscribeState()
        envelopeListeners.clear()
        problemListeners.clear()
        aesKey = null
        client.close()
        _state.value = SessionState.Disconnected
    }

    /** 当前是否已建立加密通道。 */
    val isAuthenticated: Boolean
        get() = aesKey != null && _state.value is SessionState.Connected

    override fun isOpen(): Boolean = client.isOpen()

    /** 发送一条已构建的 envelope（[Requester] 用这条）。 */
    override fun sendEnvelope(envelope: RemoteEnvelope): Boolean {
        val key = aesKey ?: return false
        val frame = encryptFrame(key, Envelope.encode(envelope))
        return client.send(Envelope.json.encodeToString(E2EFrame.serializer(), frame))
    }

    /** 便捷发送：按字段构建再发。 */
    fun sendEnvelope(
        type: String,
        sessionId: String = DEFAULT_SESSION_ID,
        payload: JsonElement? = null,
        requestId: String? = null,
        threadId: String? = null,
    ): Boolean = sendEnvelope(
        Envelope.make(
            type = type,
            sessionId = sessionId,
            payload = payload,
            requestId = requestId,
            threadId = threadId,
        ),
    )

    /** 重新握手（中继重启、或长时间无响应时由上层触发）。 */
    fun reauthenticate() {
        startAuthentication()
    }

    // ---- 入站处理 ----

    private fun handleFrame(raw: String) {
        val obj = runCatching { Envelope.json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        if (obj == null) {
            reportProblem("收到无法解析的帧（${raw.length} 字节）")
            return
        }

        if (isEncryptedFrame(obj)) {
            val key = aesKey
            if (key == null) {
                reportProblem("在通道就绪前收到加密帧，已丢弃")
                return
            }
            val frame = runCatching { Envelope.json.decodeFromString(E2EFrame.serializer(), raw) }
                .getOrElse {
                    reportProblem("加密帧格式不合法：${it.message}")
                    return
                }
            val envelope = try {
                Envelope.parse(decryptFrame(key, frame))
            } catch (e: Exception) {
                reportProblem("解密或解析失败（密钥不匹配或数据被篡改）：${e.message}")
                return
            }
            envelopeListeners.forEach { runCatching { it(envelope) } }
            return
        }

        // 明文帧：配对握手期由 Pairing 自行消费（pair.challenge 就是明文——
        // 它在密钥建立之前，必须是明文）。认证完成后主机不应再发明文帧。
        val type = obj.str("type").orEmpty()
        when (type) {
            "relay.ok" -> Unit // 重认证过程由 Pairing 读，这里无需处理

            "relay.error" -> handleRelayError(obj.str("code").orEmpty(), type)

            "revoked" -> fail(SessionFailure.Revoked, "桌面端已移除本设备")

            "replaced" -> fail(SessionFailure.Replaced, "本设备已在另一处连接")

            "offline" -> reportProblem("桌面端离线，等待其恢复")

            else -> if (isAuthenticated) {
                reportProblem("收到未加密的意外帧：$type")
            }
        }
    }

    private fun isEncryptedFrame(obj: JsonObject): Boolean =
        obj["e"]?.jsonPrimitive?.contentOrNull == "1" && obj.containsKey("n") && obj.containsKey("c")

    private fun handleRelayError(code: String, type: String) {
        when (code) {
            "NOT_AUTHENTICATED", "UNKNOWN_DEVICE", "INVALID_TOKEN" ->
                fail(SessionFailure.AuthFailed, "中继拒绝认证（$code）")

            else -> reportProblem("中继返回错误：$code（$type）")
        }
    }

    private fun handleRelayState(relayState: RelayState) {
        when (relayState) {
            RelayState.Connecting -> {
                // 不覆盖终止性失败：用户要看到的是「为什么必须重新配对」，不是「正在连接」
                if ((_state.value as? SessionState.Failed)?.reason?.isTerminal != true) {
                    _state.value = SessionState.Connecting
                }
            }

            RelayState.Open -> startAuthentication()

            is RelayState.Closed -> onClosed(relayState)

            is RelayState.Failed -> {
                aesKey = null
                scheduleReconnectOrFail(SessionFailure.Network, relayState.message)
            }

            RelayState.Idle -> Unit
        }
    }

    private fun onClosed(closed: RelayState.Closed) {
        aesKey = null
        when (closed.code) {
            // 中继重启后路由表为空，而主机的 uplink 还在重新上报已存 token。
            // 这段窗口内 hello 会被拒（4001）——若一口咬定「必须重新配对」，
            // 用户就得白白重配一次。所以先当作**可恢复**的连接问题重试几次，
            // 超出上限才判定为终止性失败。
            RelayClient.CLOSE_AUTH_FAILED -> {
                if (attempt < AUTH_RETRY_LIMIT && !stopped) {
                    attempt++
                    scheduleReconnectOrFail(
                        SessionFailure.Network,
                        "中继暂时拒绝认证（第 $attempt 次重试）",
                    )
                } else {
                    fail(SessionFailure.AuthFailed, "中继拒绝认证（令牌已失效，需要重新配对）")
                }
            }

            RelayClient.CLOSE_REVOKED -> fail(SessionFailure.Revoked, "桌面端已移除本设备")

            RelayClient.CLOSE_REPLACED -> fail(SessionFailure.Replaced, "本设备已在另一处连接")

            RelayClient.CLOSE_TOO_LARGE -> reportProblem("帧超出中继大小上限，连接被关闭")

            else -> scheduleReconnectOrFail(
                SessionFailure.Network,
                "连接中断（${closed.code} ${closed.reason}）".trim(),
            )
        }
    }

    private fun startAuthentication() {
        authJob?.cancel()
        authJob = scope.launch {
            _state.value = SessionState.Authenticating
            val token = record.deviceToken
            if (token.isNullOrEmpty()) {
                fail(SessionFailure.AuthFailed, "缺少设备令牌，需要重新配对")
                return@launch
            }
            try {
                val result = Pairing.reauthenticate(
                    client = client,
                    hostId = record.hostId,
                    identity = identity,
                    deviceToken = token,
                    deviceName = deviceName,
                )
                aesKey = result.aesKey
                attempt = 0
                authAttempts = 0
                _state.value = SessionState.Connected(record.hostId)
            } catch (e: PairingException) {
                aesKey = null
                if (stopped) return@launch
                // 网络抖动（超时 / EOF）经常表现为 PairingException。一次失败就判「需要重新配对」
                // 会让用户被迫手动重连（真机反馈「用着用着掉线」）——先当作可恢复问题重试。
                authAttempts++
                if (authAttempts >= AUTH_FAILURE_RETRY_LIMIT) {
                    scheduleReconnectOrFail(SessionFailure.AuthFailed, e.message ?: "认证失败")
                } else {
                    scheduleReconnectOrFail(
                        SessionFailure.Network,
                        "认证失败，正在自动重试（第 $authAttempts 次）：${e.message ?: ""}".trim(),
                    )
                }
            }
        }
    }

    /** 终止性失败直接上报；其余按退避重连。 */
    private fun scheduleReconnectOrFail(reason: SessionFailure, detail: String) {
        if (reason.isTerminal || stopped) {
            fail(reason, detail)
            return
        }
        reportProblem(detail)
        _state.value = SessionState.Failed(reason, detail)
        reconnectJob?.cancel()
        val delayMs = backoffMs[attempt.coerceIn(0, backoffMs.lastIndex)]
        attempt++
        reconnectJob = scope.launch {
            delay(delayMs)
            if (!stopped && !client.isOpen()) client.connect()
        }
    }

    private fun fail(reason: SessionFailure, detail: String) {
        reconnectJob?.cancel()
        authJob?.cancel()
        _state.value = SessionState.Failed(reason, detail)
    }

    private fun reportProblem(message: String) {
        problemListeners.forEach { runCatching { it(message) } }
    }

    companion object {
        /** 单机会话的固定 sessionId（主机侧只要求非空且 ≤128 字符）。 */
        const val DEFAULT_SESSION_ID = "sess-mobile"

        /** 1s → 2s → 5s → 10s → 30s，之后维持 30s。 */
        val DEFAULT_BACKOFF = listOf(1_000L, 2_000L, 5_000L, 10_000L, 30_000L)

        /**
         * 认证被拒后的重试次数上限。
         *
         * 为什么需要：中继是无状态的（重启即丢路由表），而主机 uplink 重连后会补报已存
         * token。这期间的 4001 是**暂时**的；直接判死会让用户无端重新配对。
         * 也不能无上限重试——真的是令牌失效时，应当尽快让人看到「需要重新配对」。
         */
        const val AUTH_RETRY_LIMIT = 3

        /** 认证请求连续失败多少次才认定为「令牌/密钥真的有问题」——需要重新配对。 */
        const val AUTH_FAILURE_RETRY_LIMIT = 5
    }
}

private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
