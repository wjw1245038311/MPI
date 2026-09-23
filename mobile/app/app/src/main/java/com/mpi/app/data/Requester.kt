package com.mpi.app.data

import com.mpi.app.protocol.Envelope
import com.mpi.app.protocol.RemoteEnvelope
import java.security.SecureRandom
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement

/**
 * 请求/响应式通信所需的传输能力（只需这几件事，便于测试替换）。
 * [HostSession] 直接实现它。
 */
interface RequestTransport {
    /** 发送一条已构建的 envelope；false = 通道未就绪（未认证/连接已断）。 */
    fun sendEnvelope(envelope: RemoteEnvelope): Boolean

    /** 订阅入站 envelope。**必须同步注册**（返回时已在收帧），否则会有丢帧竞态。 */
    fun onEnvelope(listener: (RemoteEnvelope) -> Unit): () -> Unit

    fun isOpen(): Boolean
}

/** 请求失败的原因——每类对应不同的用户文案与处置（§1.1）。 */
class RequestException(
    message: String,
    val kind: Kind,
    val code: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {
    enum class Kind {
        /** 主机在超时内没有回应。通道仍开着 → 可能是主机 uplink 掉了。 */
        Timeout,

        /** 通道未就绪，请求根本没发出去。 */
        NotReady,

        /** 主机返回了错误 envelope。 */
        HostError,
    }
}

/**
 * 在一条加密通道上做「带 requestId 的请求/响应」（对照 PWA 的 requester.ts）。
 *
 * 主机对请求 `<type>` 的回应是 `<type>.result`，并回带同一个 `requestId`。
 *
 * 关键顺序：**先注册等待者，再发送**。本机（以及中继在附近时）回应可能在发送
 * 调用返回之前就到了，晚注册就会丢帧——PWA 侧为此刻意不用缓冲。
 * [RequestTransport.onEnvelope] 因此约定为同步注册。
 */
class Requester(
    private val transport: RequestTransport,
    private val sessionId: String = newSessionId(),
    private val defaultTimeoutMs: Long = 10_000,
    /** 请求超时但连接仍开着时回调——主机 uplink 可能已静默掉线，上层可借此重新握手。 */
    private val onStaleConnection: (() -> Unit)? = null,
) {
    private var counter = 0

    /**
     * 发一条请求并等回应。
     *
     * @param threadId 会话 id；主机从 **envelope** 读它（不是 payload），
     *   会话内的请求必须带上。
     * @param timeoutMs 覆盖默认超时（null = 用默认）。例如压缩要读全整个会话再调一次
     *   LLM，秒级到十几秒都可能，得放宽得多。
     * @return 回应 envelope 的 payload（可能为 null）。
     */
    suspend fun request(
        type: String,
        payload: JsonElement? = null,
        label: String = type,
        threadId: String? = null,
        timeoutMs: Long? = null,
    ): JsonElement? {
        val requestId = "req-${++counter}-${randomSuffix()}"
        val envelope = Envelope.make(
            type = type,
            sessionId = sessionId,
            payload = payload,
            requestId = requestId,
            threadId = threadId,
        )

        // 容量 1：一个 requestId 只会有一个回应
        val inbox = Channel<RemoteEnvelope>(1)
        val unsubscribe = transport.onEnvelope { inbound ->
            if (inbound.requestId == requestId && inbound.type.endsWith(RESULT_SUFFIX)) {
                inbox.trySend(inbound)
            }
        }

        try {
            if (!transport.sendEnvelope(envelope)) {
                throw RequestException(
                    message = "无法发送 $label 请求（连接未就绪）",
                    kind = RequestException.Kind.NotReady,
                )
            }

            val response = try {
                withTimeout(timeoutMs ?: defaultTimeoutMs) { inbox.receive() }
            } catch (e: TimeoutCancellationException) {
                // 连接还开着却没回应 → 主机侧可能静默掉线，交给上层决定是否重握手
                if (transport.isOpen()) onStaleConnection?.invoke()
                throw RequestException(
                    message = "等待 $label 回应超时（${timeoutMs ?: defaultTimeoutMs}ms）",
                    kind = RequestException.Kind.Timeout,
                    cause = e,
                )
            }

            response.error?.let { error ->
                throw RequestException(
                    message = "$label 失败：${error.code}${if (error.message.isEmpty()) "" else " ${error.message}"}",
                    kind = RequestException.Kind.HostError,
                    code = error.code,
                )
            }
            return response.payload
        } finally {
            unsubscribe()
        }
    }

    private fun randomSuffix(): String {
        val bytes = ByteArray(4).also { SecureRandom().nextBytes(it) }
        return bytes.joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val RESULT_SUFFIX = ".result"

        /** 每次启动一个随机 sessionId，便于在主机日志里区分客户端实例。 */
        fun newSessionId(): String {
            val bytes = ByteArray(8).also { SecureRandom().nextBytes(it) }
            return "android-" + bytes.joinToString("") { "%02x".format(it) }
        }
    }
}
