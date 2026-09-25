package com.mpi.app.data

import com.mpi.app.protocol.Base64Url
import com.mpi.app.protocol.DeviceIdentity
import com.mpi.app.protocol.Envelope
import com.mpi.app.protocol.X25519
import com.mpi.app.protocol.deriveAesKey
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 配对流程 —— 与 PWA 的 mobile/pwa/src/lib/pairing.ts 同构。
 *
 * 完整时序（见 docs/MOBILE-DESIGN.md §4.2）：
 *
 *   设备 → 中继(→host)  {type:"pair.request", ticket, deviceId, name}   ← 控制帧
 *   host → 设备(→中继)  envelope pair.challenge {connectionId, challenge}
 *   设备 → host         envelope pair.hello {deviceId, deviceName, publicKeyPem,
 *                                            signature, ticket, x25519Pub}
 *   host → 设备         envelope pair.accepted {deviceToken, x25519Pub}
 *   设备                 X25519(myPriv, hostPub) → HKDF → AES-256-GCM 会话密钥
 *
 * 签名文本的格式**必须与 TS 逐字节一致**，否则主机验签失败：
 *   `mpi-remote-v1|<hostId>|<connectionId>|<challenge>|<deviceId>`
 */

/** 配对阶段（与 PWA 的 PairingStage 对齐，供 UI 显示进度）。 */
enum class PairingStage {
    Connecting,
    WaitingChallenge,
    WaitingApproval,
    Approved,
}

class PairingException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** 配对/重认证的产物。 */
class PairingResult(
    val deviceToken: String,
    /** 主机 X25519 公钥（b64url）。持久化它即可——会话密钥可随时本地复算，无需重新协商。 */
    val hostX25519PubB64u: String,
    /** 已派生的 AES-256-GCM 会话密钥。 */
    val aesKey: ByteArray,
)

object Pairing {
    private const val SIGNATURE_PREFIX = "mpi-remote-v1"

    /** 中继连接超时。 */
    const val CONNECT_TIMEOUT_MS = 10_000L

    /** 等 pair.challenge（中继→host→设备，多一跳）。 */
    const val CHALLENGE_TIMEOUT_MS = 20_000L

    /** 等 pair.accepted：新设备要等桌面端点「允许」，给足 5 分钟。 */
    const val ACCEPTED_TIMEOUT_MS = 5 * 60_000L

    /** 重认证时主机通常立刻回，30 秒够。 */
    const val REAUTH_ACCEPTED_TIMEOUT_MS = 30_000L

    /** 签名文本（与 TS 的 signedText 逐字节一致）。 */
    fun signedText(hostId: String, connectionId: String, challenge: String, deviceId: String): String =
        "$SIGNATURE_PREFIX|$hostId|$connectionId|$challenge|$deviceId"

    /**
     * 全新配对：连中继 → pair.request → 应答挑战 → 拿到 deviceToken 与会话密钥。
     */
    suspend fun run(
        client: RelayClient,
        hostId: String,
        ticket: String,
        identity: DeviceIdentity,
        deviceName: String,
        acceptedTimeoutMs: Long = ACCEPTED_TIMEOUT_MS,
        onStage: (PairingStage) -> Unit = {},
    ): PairingResult {
        onStage(PairingStage.Connecting)
        connectAndAwaitOpen(client)

        // 先建流再发帧：否则中继回得够快时，挑战会在注册监听（FrameStream）之前到达并丢失。
        val stream = FrameStream(client)
        try {
            // 首帧决定 socket 角色——必须是 pair.request。
            if (!client.send(ControlFrames.pairRequest(ticket, identity.deviceId, deviceName))) {
                throw PairingException("无法发送 pair.request（连接已关闭）")
            }
            onStage(PairingStage.WaitingChallenge)
            return answerChallenge(stream, hostId, identity, deviceName, ticket, acceptedTimeoutMs, onStage)
        } finally {
            stream.close()
        }
    }

    /**
     * 重认证：已配对设备（重）连上后，发 `hello` 让中继通知 host 重发挑战，
     * 应答后拿到**新的 pair.accepted**——会话密钥由静态身份重新派生，结果与首次相同。
     */
    suspend fun reauthenticate(
        client: RelayClient,
        hostId: String,
        identity: DeviceIdentity,
        deviceToken: String,
        deviceName: String,
        acceptedTimeoutMs: Long = REAUTH_ACCEPTED_TIMEOUT_MS,
        onStage: (PairingStage) -> Unit = {},
    ): PairingResult {
        onStage(PairingStage.Connecting)
        connectAndAwaitOpen(client)
        val stream = FrameStream(client)
        try {
            if (!client.send(ControlFrames.hello(identity.deviceId, deviceToken, hostId))) {
                throw PairingException("无法发送 hello（连接已关闭）")
            }
            onStage(PairingStage.WaitingChallenge)
            return answerChallenge(stream, hostId, identity, deviceName, "", acceptedTimeoutMs, onStage)
        } finally {
            stream.close()
        }
    }

    // ---- 内部 ----

    private suspend fun answerChallenge(
        stream: FrameStream,
        hostId: String,
        identity: DeviceIdentity,
        deviceName: String,
        ticket: String,
        acceptedTimeoutMs: Long,
        onStage: (PairingStage) -> Unit,
    ): PairingResult {
        val challenge = stream.await("pair.challenge", CHALLENGE_TIMEOUT_MS)
        val sessionId = challenge.str("sessionId") ?: throw PairingException("pair.challenge 缺少 sessionId")
        val payload = challenge["payload"]?.jsonObject ?: throw PairingException("pair.challenge 缺少 payload")
        val connectionId = payload.str("connectionId") ?: throw PairingException("pair.challenge 缺少 connectionId")
        val challengeValue = payload.str("challenge") ?: throw PairingException("pair.challenge 缺少 challenge")

        onStage(PairingStage.WaitingApproval)
        val signature = identity.signText(signedText(hostId, connectionId, challengeValue, identity.deviceId))
        val hello = Envelope.encode(
            Envelope.make(
                type = "pair.hello",
                sessionId = sessionId,
                payload = buildJsonObject {
                    put("deviceId", identity.deviceId)
                    put("deviceName", deviceName)
                    put("publicKeyPem", identity.publicKeyPem)
                    put("signature", signature)
                    put("ticket", ticket)
                    // E2E：主机据此派生会话密钥
                    put("x25519Pub", identity.x25519PubB64u)
                },
            ),
        )
        if (!stream.send(hello)) throw PairingException("无法发送 pair.hello（连接已关闭）")

        // 已信任设备立刻返回；新设备要等桌面端批准。
        val accepted = stream.await("pair.accepted", acceptedTimeoutMs)
        val acceptedPayload = accepted["payload"]?.jsonObject
            ?: throw PairingException("pair.accepted 缺少 payload")
        val deviceToken = acceptedPayload.str("deviceToken").orEmpty()
        if (deviceToken.isEmpty()) throw PairingException("pair.accepted 未返回 deviceToken")
        val hostX25519Pub = acceptedPayload.str("x25519Pub").orEmpty()

        val aesKey = if (hostX25519Pub.isEmpty()) {
            ByteArray(0)
        } else {
            deriveAesKey(
                X25519.sharedSecretB64u(identity.x25519PrivB64u, hostX25519Pub),
                hostId,
                identity.deviceId,
            )
        }

        onStage(PairingStage.Approved)
        return PairingResult(deviceToken = deviceToken, hostX25519PubB64u = hostX25519Pub, aesKey = aesKey)
    }

    private suspend fun connectAndAwaitOpen(client: RelayClient) {
        if (client.isOpen()) return
        client.connect()
        withTimeout(CONNECT_TIMEOUT_MS) {
            val states = Channel<RelayState>(Channel.UNLIMITED)
            val unsubscribe = client.onState { states.trySend(it) }
            try {
                if (client.isOpen()) return@withTimeout
                while (true) {
                    when (val state = states.receive()) {
                        is RelayState.Open -> return@withTimeout

                        is RelayState.Failed -> throw PairingException("无法连接中继：${state.message}")

                        // 本端主动放弃（kick 重建）不是失败：让上层走它自己的重建流程。
                        is RelayState.Closed -> if (!state.expected) {
                            throw PairingException("中继断开连接：${state.code} ${state.reason}".trim())
                        }

                        else -> Unit
                    }
                }
            } finally {
                unsubscribe()
            }
        }
    }

    /**
     * 把一路 socket 的帧收集到 Channel，供 `await(type)` 顺序取用。
     *
     * 两类「失败要快」：
     * ① 中继/主机发来的错误帧；
     * ② **连接被关闭/失败**——否则用户会干等到超时（违反了「不静默失败」的原则）。
     */
    private class FrameStream(private val client: RelayClient) {
        private val frames = Channel<JsonObject>(Channel.UNLIMITED)
        private val failures = Channel<PairingException>(Channel.UNLIMITED)

        private val unsubscribeFrame: () -> Unit = client.onFrame { raw ->
            val parsed = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
            if (parsed != null) frames.trySend(parsed)
        }

        private val unsubscribeState: () -> Unit = client.onState { state ->
            when (state) {
                is RelayState.Failed -> failures.trySend(PairingException("连接失败：${state.message}"))

                // 本端主动放弃（kick 重建）不当作失败上报——上层会用新 socket 重新握手。
                // 旧写法把「自己关的 1000」报成「中继关闭了连接：1000」，用户看到的是一条
                // 完全误导的错误（2026-09-26 真机事故）。
                is RelayState.Closed -> if (!state.expected) {
                    failures.trySend(
                        PairingException("中继关闭了连接：${state.code} ${state.reason}".trim()),
                    )
                }

                else -> Unit
            }
        }

        fun send(rawJson: String): Boolean = client.send(rawJson)

        @OptIn(ExperimentalCoroutinesApi::class)
        suspend fun await(type: String, timeoutMs: Long): JsonObject = withTimeout(timeoutMs) {
            var found: JsonObject? = null
            while (found == null) {
                select {
                    failures.onReceive { throw it }

                    frames.onReceive { frame ->
                        when (frame.str("type")) {
                            "relay.error" -> throw PairingException("中继错误：${frame.str("code") ?: "unknown"}")

                            "error" -> {
                                val error = frame["error"]?.jsonObject
                                val code = error?.str("code").orEmpty()
                                val message = error?.str("message").orEmpty()
                                throw PairingException("主机错误：$code $message".trim())
                            }

                            type -> found = frame
                        }
                    }
                }
            }
            found!!
        }

        fun close() {
            unsubscribeFrame()
            unsubscribeState()
            frames.close()
            failures.close()
        }
    }
}

private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
