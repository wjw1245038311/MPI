package com.mpi.app

import com.mpi.app.data.Pairing
import com.mpi.app.data.RelayClient
import com.mpi.app.data.RelayState
import com.mpi.app.protocol.Base64Url
import com.mpi.app.protocol.Envelope
import com.mpi.app.protocol.RemoteEnvelope
import com.mpi.app.protocol.X25519
import com.mpi.app.protocol.createDeviceIdentity
import com.mpi.app.protocol.decryptFrame
import com.mpi.app.protocol.deriveAesKey
import com.mpi.app.protocol.encryptFrame
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M0-4b：完整配对流程 —— 对真实中继跑一遍，主机侧由测试内的假 host 扮演。
 *
 * 覆盖三件事（都是 M1 的关键路径）：
 *   ① 配对时序：pair.request → pair.challenge → pair.hello → pair.accepted
 *   ② **主机验签通过** —— 证明签名文本与 SPKI PEM 的格式与 TS 侧逐字节一致
 *   ③ **E2E 会话密钥** —— 主机用自己派生的密钥能解开设备加密的帧；
 *      且重认证后派生出**同一把**密钥（静态身份 → 无需重新协商）
 */
class PairingTest : RelayTestBase() {

    private val hostId = "host-pair-test"
    private val ticket = "ticket-android-1"
    private val connectionId = "conn-1"
    private val challengeValue = "challenge-abc"
    private val deviceToken = "device-token-from-host"
    private val hostX25519Priv = Base64Url.encode(ByteArray(32) { 0x33.toByte() })
    private val hostX25519Pub = Base64Url.encode(X25519.publicKeyFromPrivate(Base64Url.decode(hostX25519Priv)))

    @Test
    fun `pairing over a real relay verifies the signature and yields a working E2E session`() = runBlocking {
        val hostClient = RelayClient(url())
        val hostRecording = Recording().attach(hostClient)
        val hostInbox = Channel<JsonObject>(Channel.UNLIMITED)
        hostClient.onFrame { raw ->
            (runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull())?.let { hostInbox.trySend(it) }
        }

        hostClient.connect()
        hostRecording.awaitState(RelayState.Open::class.java)
        assertTrue(hostClient.send(EnvelopeSource.hostRegister(hostId)))
        hostRecording.awaitFrame("relay.ok")
        assertTrue(hostClient.send(EnvelopeSource.ticketRegister(ticket)))
        hostRecording.awaitFrame("relay.ok")

        // 假 host 的应答循环：收到 pair.request / device.online 就发挑战；
        // 收到 pair.hello 就验签并回 pair.accepted。
        val firstSignature = CompletableDeferred<Pair<String, Boolean>>()
        val signatures = mutableListOf<Boolean>()
        val hostLoop = launch(Dispatchers.IO) {
            while (isActive) {
                val frame = hostInbox.receive()
                when (frame.str("type")) {
                    "pair.request", "device.online" -> {
                        val deviceId = frame.str("deviceId") ?: continue
                        hostClient.send(Envelope.encode(hostChallenge(deviceId)))
                    }

                    "pair.hello" -> {
                        val payload = frame["payload"]?.jsonObject ?: continue
                        val deviceId = payload.str("deviceId").orEmpty()
                        val signedText = Pairing.signedText(hostId, connectionId, challengeValue, deviceId)
                        val verified = verifyEd25519(
                            publicKeyFromSpkiPem(payload.str("publicKeyPem").orEmpty()),
                            signedText.toByteArray(Charsets.UTF_8),
                            Base64Url.decode(payload.str("signature").orEmpty()),
                        )
                        signatures += verified
                        if (!firstSignature.isCompleted) firstSignature.complete(deviceId to verified)
                        // 真实桌面端在「批准」时会先用 pair.approved 把 token 注册给中继
                        // （否则记录里 token 为 null，后续 hello 重认证会被拒）。
                        hostClient.send(EnvelopeSource.pairApproved(deviceId, deviceToken))
                        hostClient.send(
                            Envelope.encode(hostAccepted(frame.str("sessionId").orEmpty(), deviceId)),
                        )
                    }
                }
            }
        }

        // ---- 被测：设备端配对 ----
        val identity = createDeviceIdentity()
        val deviceClient = RelayClient(url())
        val result = Pairing.run(deviceClient, hostId, ticket, identity, "测试手机")

        assertEquals("应拿到主机下发的 deviceToken", deviceToken, result.deviceToken)
        assertEquals("应拿到主机 X25519 公钥", hostX25519Pub, result.hostX25519PubB64u)
        assertEquals("会话密钥应为 32 字节", 32, result.aesKey.size)

        val (signedDeviceId, signatureOk) = firstSignature.await()
        assertEquals("签名文本里的 deviceId 应与设备身份一致", identity.deviceId, signedDeviceId)
        assertTrue("主机必须验签通过（证明签名文本与 SPKI PEM 与 TS 一致）", signatureOk)

        // ---- E2E：主机用自己派生的密钥解开设备加密的帧 ----
        val hostKey = deriveAesKey(
            X25519.sharedSecret(Base64Url.decode(hostX25519Priv), Base64Url.decode(identity.x25519PubB64u)),
            hostId,
            identity.deviceId,
        )
        val plain = """{"v":1,"type":"projects.list","sessionId":"sess-1"}"""
        assertEquals("主机应能解开设备加密的帧", plain, decryptFrame(hostKey, encryptFrame(result.aesKey, plain)))

        // ---- 重认证：同一静态身份派生出同一把密钥，无需重新协商 ----
        // 先断掉旧 socket：R1（relay de40857）之后，**同 socket 重复 hello 不再通知主机**
        // （否则主机会重建逻辑连接、清空订阅与写租约，而设备感知不到 → 静默丢事件，09-24 真机事故）。
        // 因此生产上的恢复路径是「断线 → 新 socket → hello → 主机发挑战」，这里照此模拟。
        deviceClient.close()
        val reauth = Pairing.reauthenticate(deviceClient, hostId, identity, deviceToken, "测试手机")
        assertEquals("重认证应拿到同一 deviceToken", deviceToken, reauth.deviceToken)
        assertArrayEquals("重认证后的会话密钥应与首次相同（确定性派生）", result.aesKey, reauth.aesKey)
        assertTrue("两次 pair.hello 都应验签通过", signatures.size >= 2 && signatures.all { it })

        hostLoop.cancel()
        deviceClient.close()
        hostClient.close()
    }

    // ---- 假 host 发出的控制/协议帧 ----

    private fun hostChallenge(deviceId: String): RemoteEnvelope = Envelope.make(
        type = "pair.challenge",
        sessionId = "sess-challenge",
        payload = buildJsonObject {
            put("connectionId", connectionId)
            put("challenge", challengeValue)
        },
        to = deviceId,
    )

    private fun hostAccepted(sessionId: String, deviceId: String): RemoteEnvelope = Envelope.make(
        type = "pair.accepted",
        sessionId = sessionId.ifEmpty { "sess-challenge" },
        payload = buildJsonObject {
            put("deviceToken", deviceToken)
            put("x25519Pub", hostX25519Pub)
        },
        to = deviceId,
    )
}
