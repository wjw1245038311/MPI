package com.mpi.app

import com.mpi.app.data.Pairing
import com.mpi.app.data.RelayClient
import com.mpi.app.data.RelayState
import com.mpi.app.protocol.Base64Url
import com.mpi.app.protocol.E2EFrame
import com.mpi.app.protocol.Envelope
import com.mpi.app.protocol.RemoteEnvelope
import com.mpi.app.protocol.X25519
import com.mpi.app.protocol.decryptFrame
import com.mpi.app.protocol.deriveAesKey
import com.mpi.app.protocol.encryptFrame
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

/**
 * 测试用的**假桌面端**：扮演主机 uplink 的协议一侧。
 *
 * 覆盖握手（注册 → 挑战 → 验签 → 批准 → E2E 建钥）与后续加密帧收发，
 * 供配对与主机会话的测试共用。刻意照抄真实主机的**关键顺序**——
 * 特别是「先 pair.approved 把 token 注册给中继，再回 pair.accepted」
 * （漏掉前一步，后续 hello 重认证会被中继拒绝：relay 记录里 token 仍为 null）。
 */
internal class FakeHost(
    private val client: RelayClient,
    private val hostId: String,
    private val deviceToken: String,
    private val scope: CoroutineScope,
    private val connectionId: String = "conn-test",
    private val challengeValue: String = "challenge-test",
) {
    private val x25519PrivB64u: String = Base64Url.encode(ByteArray(32) { 0x33.toByte() })
    val x25519PubB64u: String = Base64Url.encode(X25519.publicKeyFromPrivate(Base64Url.decode(x25519PrivB64u)))

    private val inbox = Channel<JsonObject>(Channel.UNLIMITED)

    /** 主机侧收到的、已成功解密的设备帧。 */
    val received = Channel<RemoteEnvelope>(Channel.UNLIMITED)

    /** 每次 pair.hello 的验签结果（断言签名格式与 TS 一致）。 */
    val signatureChecks = mutableListOf<Boolean>()

    @Volatile
    var deviceId: String? = null
        private set

    @Volatile
    private var aesKey: ByteArray? = null

    init {
        client.onFrame { raw ->
            runCatching { Envelope.json.parseToJsonElement(raw) as? JsonObject }
                .getOrNull()
                ?.let { inbox.trySend(it) }
        }
    }

    /** 连接中继并注册；可选再登记一张配对票据。 */
    suspend fun start(ticket: String? = null) {
        client.connect()
        awaitOpen()
        client.send("""{"type":"host.register","hostId":"$hostId"}""")
        awaitInboxType("relay.ok")
        if (ticket != null) {
            client.send("""{"type":"ticket.register","ticket":"$ticket"}""")
            awaitInboxType("relay.ok")
        }
    }

    /** 启动应答循环（处理挑战、pair.hello、加密帧）。 */
    fun launch() {
        scope.launch(Dispatchers.IO) { loop() }
    }

    /** 桌面端「移除设备」。 */
    fun revoke(deviceId: String) {
        client.send("""{"type":"device.revoke","deviceId":"$deviceId"}""")
    }

    /** 预先把设备标记为已批准（相当于“这台手机以前配对过”）。 */
    fun approve(deviceId: String) {
        client.send("""{"type":"pair.approved","deviceId":"$deviceId","deviceToken":"$deviceToken"}""")
    }

    /** 主机 → 设备：一条加密协议帧。 */
    fun sendEncrypted(type: String, payload: JsonElement? = null, sessionId: String = "sess-host"): Boolean {
        val key = aesKey ?: return false
        val target = deviceId ?: return false
        val envelope = Envelope.make(type = type, sessionId = sessionId, payload = payload)
        val frame = encryptFrame(key, Envelope.encode(envelope))
        val withTarget = buildJsonObject {
            put("e", frame.e)
            put("n", frame.n)
            put("c", frame.c)
            put("to", target)
        }
        return client.send(withTarget.toString())
    }

    /** 等主机收到指定 type 的设备帧（跳过其它）。 */
    suspend fun awaitReceived(type: String, timeoutMs: Long = FRAME_TIMEOUT_MS): RemoteEnvelope =
        withTimeout(timeoutMs) {
            var found: RemoteEnvelope? = null
            while (found == null) {
                val envelope = received.receive()
                if (envelope.type == type) found = envelope
            }
            found!!
        }

    // ---- 内部 ----

    private suspend fun loop() {
        while (true) {
            val frame = inbox.receive()
            when (frame.str("type")) {
                "pair.request", "device.online" -> {
                    val id = frame.str("deviceId") ?: continue
                    deviceId = id
                    sendChallenge(id)
                }

                "pair.hello" -> handlePairHello(frame)

                else -> if (EncryptedFrames.isEncrypted(frame)) {
                    val key = aesKey ?: continue
                    EncryptedFrames.decrypt(key, frame)?.let { received.trySend(it) }
                }
            }
        }
    }

    private fun sendChallenge(deviceId: String) {
        client.send(
            Envelope.encode(
                Envelope.make(
                    type = "pair.challenge",
                    sessionId = "sess-challenge",
                    payload = buildJsonObject {
                        put("connectionId", connectionId)
                        put("challenge", challengeValue)
                    },
                    to = deviceId,
                ),
            ),
        )
    }

    private fun handlePairHello(frame: JsonObject) {
        val payload = frame["payload"]?.jsonObject ?: return
        val id = payload.str("deviceId").orEmpty()
        deviceId = id

        val signedText = Pairing.signedText(hostId, connectionId, challengeValue, id)
        signatureChecks += verifyEd25519(
            publicKeyFromSpkiPem(payload.str("publicKeyPem").orEmpty()),
            signedText.toByteArray(Charsets.UTF_8),
            Base64Url.decode(payload.str("signature").orEmpty()),
        )

        // 真实桌面端的顺序：先把 token 注册给中继（用户点「允许」），再回 accepted
        client.send("""{"type":"pair.approved","deviceId":"$id","deviceToken":"$deviceToken"}""")

        payload.str("x25519Pub")?.let { devicePub ->
            aesKey = deriveAesKey(
                X25519.sharedSecret(Base64Url.decode(x25519PrivB64u), Base64Url.decode(devicePub)),
                hostId,
                id,
            )
        }

        client.send(
            Envelope.encode(
                Envelope.make(
                    type = "pair.accepted",
                    sessionId = frame.str("sessionId").orEmpty().ifEmpty { "sess-challenge" },
                    payload = buildJsonObject {
                        put("deviceToken", deviceToken)
                        put("x25519Pub", x25519PubB64u)
                    },
                    to = id,
                ),
            ),
        )
    }

    private suspend fun awaitOpen() = withTimeout(FRAME_TIMEOUT_MS) {
        val states = Channel<RelayState>(Channel.UNLIMITED)
        val unsubscribe = client.onState { states.trySend(it) }
        try {
            if (client.isOpen()) return@withTimeout
            while (true) {
                when (val state = states.receive()) {
                    is RelayState.Open -> return@withTimeout
                    is RelayState.Failed -> error("假 host 连不上中继：${state.message}")
                    is RelayState.Closed -> error("假 host 连接被关闭：${state.code}")
                    else -> Unit
                }
            }
        } finally {
            unsubscribe()
        }
    }

    private suspend fun awaitInboxType(type: String): JsonObject = withTimeout(FRAME_TIMEOUT_MS) {
        var found: JsonObject? = null
        while (found == null) {
            val frame = inbox.receive()
            if (frame.str("type") == type) found = frame
        }
        found!!
    }

    private companion object {
        const val FRAME_TIMEOUT_MS = 10_000L
    }
}

/** 测试侧的加密帧小工具（判定与生产代码保持一致）。 */
internal object EncryptedFrames {
    fun isEncrypted(obj: JsonObject): Boolean =
        obj["e"]?.jsonPrimitive?.content == "1" && obj.containsKey("n") && obj.containsKey("c")

    fun decrypt(key: ByteArray, obj: JsonObject): RemoteEnvelope? = runCatching {
        Envelope.parse(
            decryptFrame(key, Envelope.json.decodeFromString(E2EFrame.serializer(), obj.toString())),
        )
    }.getOrNull()
}

internal fun publicKeyFromSpkiPem(pem: String): ByteArray {
    val base64 = pem.lineSequence().filterNot { it.startsWith("-----") }.joinToString("")
    val der = Base64.getDecoder().decode(base64)
    return der.copyOfRange(der.size - 32, der.size)
}

internal fun verifyEd25519(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
    val signer = Ed25519Signer()
    signer.init(false, Ed25519PublicKeyParameters(publicKey, 0))
    signer.update(message, 0, message.size)
    return signer.verifySignature(signature)
}
