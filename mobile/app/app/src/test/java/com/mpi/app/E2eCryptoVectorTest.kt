package com.mpi.app

import com.mpi.app.protocol.Base64Url
import com.mpi.app.protocol.E2EFrame
import com.mpi.app.protocol.Envelope
import com.mpi.app.protocol.X25519
import com.mpi.app.protocol.createDeviceIdentity
import com.mpi.app.protocol.deriveAesKey
import com.mpi.app.protocol.deriveX25519Priv
import com.mpi.app.protocol.decryptFrame
import com.mpi.app.protocol.e2eInfoString
import com.mpi.app.protocol.encryptFrame
import com.mpi.app.protocol.aesGcmEncrypt
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M0-5：加密实现的跨端一致性闸门（docs/MOBILE-NATIVE-DESIGN.md §2.5 证伪项 1）。
 *
 * 这里的**钉死向量全部由 PWA 的 TS 参考实现生成**（noble + WebCrypto）。
 * 生成脚本（已入库，可重现）：`node --experimental-transform-types scripts/gen-android-vectors.mjs`
 * 跑一遍即可重新打印全部下列常量。
 * Kotlin 侧只要与它们逐字节相同，就证明三端（Node 主机 / PWA / Android）能互通。
 *
 * ⚠️ 不要手改这些常量。要重算时重跑上述脚本，并同步更新 scripts/test-e2e-crypto.mjs 的 PINNED_* 值。
 */
class E2eCryptoVectorTest {

    // ---- 固定输入（与 scripts/test-e2e-crypto.mjs 同一组）----
    private val hostId = "host-test-vector"
    private val deviceId = "device-test-vector"
    private val privA = Base64Url.encode(ByteArray(32) { 0x77.toByte() })
    private val privB = Base64Url.encode(ByteArray(32) { 0x42.toByte() })
    private val basePoint = Base64Url.encode(ByteArray(32) { if (it == 0) 9.toByte() else 0 })

    // ---- 钉死向量（来自 TS 参考实现）----
    private val pinnedPubA = "HPV5q6RaELodHvBtkfyiqp7QoRUFFWUxVUBdCxjLmmc"
    private val pinnedPubB = "EyxEK-AQ-9V-cmAzKKp25x_MwVA6riGTJ9FNnJmT9HI"
    private val pinnedSharedHex = "af724d91134324137a0b11d6404bd33509b5019bc7b4437c2e82e4347006456c"
    private val pinnedAesKeyHex = "42ba6d7d8249b9482c7987b7b12b7a283c1ef4ab9c9983ca0c8934bc1ee62b0e"

    private val plainJson = """{"v":1,"type":"projects.list","reqId":"req-v1","sessionId":"sess-v1"}"""
    private val pinnedNonce = "mR5ft_iHzFzX7upr"
    private val pinnedCipher =
        "8jwYgzlcUNESRtbn_z-uGN82wnOoYZkG5oZ9z5jv4nFj3iYAUMqgCGT4J16PoE88BACVx-63AL6DOL-E9QHhg355lPjtawN9Qhgy-vWij9_KOtnK6w"

    // ---- 固定种子的设备身份向量 ----
    private val pinnedSeed = "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo" // 32 × 0x5a
    private val pinnedDeviceId = "device-ngj-gGz0zRsvwEXtmRzIC13G"
    private val pinnedX25519Pub = "LskKQ96RhY9Um5j-df_mQx-w1dvARuYW1i67PVQ9a1w"
    private val pinnedX25519Priv = "iISJdSqRySdmnINahWBqocRSqJ-eRBFZg1iv9PdtIP4"
    private val pinnedPem = "-----BEGIN PUBLIC KEY-----\n" +
        "MCowBQYDK2VwAyEADXVQdU4IAKXSN+71gmA1dmubPloVhoqUCrKJlYeI47A=\n" +
        "-----END PUBLIC KEY-----\n"
    private val pinnedSignature =
        "TP_21kdRzyz-SzbiPgOyKelxuwzLK6zpxmDJXcv1_IeRJFz_ZkXMXXea6thx1PjNgYtVopqC3KMq9KXxWTZ_DQ"

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    // ---- 1. X25519 公钥推导（基点标量乘）----

    @Test
    fun `X25519 public keys match pinned vectors`() {
        assertEquals(pinnedPubA, X25519.publicKeyB64u(privA))
        assertEquals(pinnedPubB, X25519.publicKeyB64u(privB))
        // 与 TS 侧同样支持直接以基点作为「对方公钥」求共享密钥的写法
        assertEquals(pinnedPubA, Base64Url.encode(X25519.sharedSecretB64u(privA, basePoint)))
    }

    // ---- 2. X25519 共享密钥 ----

    @Test
    fun `X25519 shared secret matches pinned vector and is commutative`() {
        val sharedAB = X25519.sharedSecretB64u(privA, pinnedPubB)
        assertEquals(pinnedSharedHex, hex(sharedAB))

        val sharedBA = X25519.sharedSecretB64u(privB, pinnedPubA)
        assertEquals(pinnedSharedHex, hex(sharedBA))

        // 显式走 ByteArray 入口（协议层内部形态）
        val sharedRaw = X25519.sharedSecret(Base64Url.decode(privA), Base64Url.decode(pinnedPubB))
        assertEquals(pinnedSharedHex, hex(sharedRaw))
    }

    // ---- 3. HKDF → AES-256 密钥 ----

    @Test
    fun `HKDF derived AES key matches pinned vector`() {
        assertEquals("mpi-mobile-v1|$hostId|$deviceId", e2eInfoString(hostId, deviceId))
        val shared = X25519.sharedSecretB64u(privA, pinnedPubB)
        val key = deriveAesKey(shared, hostId, deviceId)
        assertEquals(32, key.size)
        assertEquals(pinnedAesKeyHex, hex(key))
    }

    // ---- 4. 双向互通：解开 TS 产的密文 + 用同一 nonce 复现 TS 的密文 ----

    @Test
    fun `decrypts frame produced by the TypeScript implementation`() {
        val key = keyForPinnedVector()
        val plain = decryptFrame(key, E2EFrame(e = 1, n = pinnedNonce, c = pinnedCipher))
        assertEquals(plainJson, plain)
    }

    @Test
    fun `encrypting with the pinned nonce reproduces the TypeScript ciphertext`() {
        // AES-GCM 在 (key, nonce, plaintext) 固定时结果确定 —— 因此这条能证明
        // Kotlin 的加密输出与 TS 逐字节相同（不只是「能互相解开」）。
        val key = keyForPinnedVector()
        val frame = encryptFrame(key, plainJson, Base64Url.decode(pinnedNonce))
        assertEquals(pinnedNonce, frame.n)
        assertEquals(pinnedCipher, frame.c)
        assertEquals(1, frame.e)
    }

    @Test
    fun `random nonce round trip works`() {
        val key = keyForPinnedVector()
        val frame = encryptFrame(key, plainJson)
        assertNotEquals(pinnedNonce, frame.n)
        assertEquals(plainJson, decryptFrame(key, frame))
    }

    // ---- 5. 篡改检测 ----

    @Test
    fun `tampered ciphertext is rejected`() {
        val key = keyForPinnedVector()
        val bytes = Base64Url.decode(pinnedCipher)
        bytes[0] = (bytes[0].toInt() xor 0x01).toByte()
        try {
            decryptFrame(key, E2EFrame(e = 1, n = pinnedNonce, c = Base64Url.encode(bytes)))
            fail("tampered ciphertext must be rejected")
        } catch (e: Exception) {
            assertTrue(e !is AssertionError)
        }
    }

    @Test
    fun `wrong nonce is rejected`() {
        val key = keyForPinnedVector()
        val nonce = Base64Url.decode(pinnedNonce)
        nonce[3] = (nonce[3].toInt() xor 0x80).toByte()
        try {
            decryptFrame(key, E2EFrame(e = 1, n = Base64Url.encode(nonce), c = pinnedCipher))
            fail("wrong nonce must be rejected")
        } catch (e: Exception) {
            assertTrue(e !is AssertionError)
        }
    }

    @Test
    fun `invalid nonce length is rejected`() {
        val key = keyForPinnedVector()
        try {
            decryptFrame(key, E2EFrame(e = 1, n = Base64Url.encode(ByteArray(11)), c = pinnedCipher))
            fail("nonce must be exactly 12 bytes")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("nonce"))
        }
    }

    // ---- 7. 线格式必须带上版本字段（回归；曾因 encodeDefaults=false 把 e/v 省略）----

    @Test
    fun `wire format always carries the version fields`() {
        val key = keyForPinnedVector()

        // 加密帧：PWA 靠 `frame.e === 1` 判定「这是加密帧」，缺了就会被当明文处理
        val frameJson = Envelope.json.encodeToString(E2EFrame.serializer(), encryptFrame(key, plainJson))
        assertTrue("加密帧必须带 e=1，实际：$frameJson", frameJson.contains("\"e\":1"))
        assertTrue(frameJson.contains("\"n\"") && frameJson.contains("\"c\""))

        // 协议 envelope：主机 parseEnvelope 会校验 v === 1
        val envelopeJson = Envelope.encode(Envelope.make("projects.list", "sess-wire"))
        assertTrue("envelope 必须带 v=1，实际：$envelopeJson", envelopeJson.contains("\"v\":1"))
        assertTrue(envelopeJson.contains("\"type\":\"projects.list\""))

        // 可选字段为 null 时不应出现在线格式里（主机把 null 当作非法类型）
        assertTrue("null 字段不应被序列化：$envelopeJson", !envelopeJson.contains("null"))
        assertTrue(!envelopeJson.contains("requestId"))
    }

    @Test
    fun `envelope round trips through the wire format`() {
        val original = Envelope.make(
            type = "thread.prompt",
            sessionId = "sess-1",
            payload = buildJsonObject { put("text", "hi") },
            requestId = "req-9",
        )
        val parsed = Envelope.parse(Envelope.encode(original))
        assertEquals(original.type, parsed.type)
        assertEquals(original.sessionId, parsed.sessionId)
        assertEquals(original.requestId, parsed.requestId)
        assertEquals(original.v, parsed.v)
        assertEquals("hi", parsed.payload?.jsonObject?.get("text")?.jsonPrimitive?.content)
    }

    @Test
    fun `malformed envelopes are rejected with the same codes as the TypeScript side`() {
        // 缺 v → UNSUPPORTED_VERSION（TS 侧 v 为 undefined 时同样抛这个）
        try {
            Envelope.parse("""{"type":"x","sessionId":"s","sentAt":1}""")
            fail("缺 v 应被拒绝")
        } catch (e: com.mpi.app.protocol.RemoteProtocolException) {
            assertEquals("UNSUPPORTED_VERSION", e.code)
        }
        try {
            Envelope.parse("not json")
            fail("非 JSON 应被拒绝")
        } catch (e: com.mpi.app.protocol.RemoteProtocolException) {
            assertEquals("INVALID_JSON", e.code)
        }
        // v 不对
        try {
            Envelope.parse("""{"v":2,"type":"x","sessionId":"s","sentAt":1}""")
            fail("协议版本不符应被拒绝")
        } catch (e: com.mpi.app.protocol.RemoteProtocolException) {
            assertEquals("UNSUPPORTED_VERSION", e.code)
        }
    }

    // ---- 6. 设备身份（固定种子 → deviceId / PEM / X25519 / 签名全部钉死）----

    @Test
    fun `device identity from fixed seed matches the TypeScript implementation`() {
        val identity = createDeviceIdentity(pinnedSeed)
        assertEquals(pinnedDeviceId, identity.deviceId)
        assertEquals(pinnedPem, identity.publicKeyPem)
        assertEquals(pinnedX25519Pub, identity.x25519PubB64u)
        assertEquals(pinnedX25519Priv, identity.x25519PrivB64u)
        // Ed25519（RFC 8032）签名是确定性的 → 必须逐字节相同
        assertEquals(pinnedSignature, identity.signText("hello-mpi"))
    }

    @Test
    fun `X25519 derivation is deterministic per seed`() {
        val seed = Base64Url.decode(pinnedSeed)
        assertEquals(
            Base64Url.encode(deriveX25519Priv(seed)),
            Base64Url.encode(deriveX25519Priv(seed)),
        )
        assertEquals(pinnedX25519Priv, Base64Url.encode(deriveX25519Priv(seed)))
    }

    @Test
    fun `fresh identity is self consistent`() {
        val a = createDeviceIdentity()
        val b = createDeviceIdentity()
        assertNotEquals(a.deviceId, b.deviceId)
        assertTrue(a.deviceId.startsWith("device-"))
        assertEquals(24, a.deviceId.removePrefix("device-").length)
        assertEquals(a.deviceId, createDeviceIdentity(a.seedB64u).deviceId)
    }

    private fun keyForPinnedVector(): ByteArray =
        deriveAesKey(X25519.sharedSecretB64u(privA, pinnedPubB), hostId, deviceId)
}
