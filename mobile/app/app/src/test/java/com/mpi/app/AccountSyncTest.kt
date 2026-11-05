package com.mpi.app

import com.mpi.app.data.AccountApi
import com.mpi.app.data.AccountSync
import com.mpi.app.data.AcctCrypto
import com.mpi.app.data.PairingRecord
import com.mpi.app.data.SyncPayload
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 账号同步的客户端核心（加密 / 合并 / 地址推导）。
 *
 * 背景（2026-11-05 用户需求）：多台主机，登录后同步个人配置；手机卸载后连接信息不能丢。
 * 这里钉死三件容易退化的事：
 *   1. **密钥派生可复现**——换设备输入同一密码必须拿到同一把钥匙，否则同步包永远解不开；
 *   2. **服务器只见密文**——密文里不能出现 deviceToken 明文，篡改/错密钥必须解不开；
 *   3. **合并是本地优先**——一次同步不能把本机正在用的配对覆盖掉，也不能删掉远端的。
 */
class AccountSyncTest {

    private fun pairing(hostId: String, relay: String = "wss://relay.example:9443/ws") = PairingRecord(
        hostId = hostId,
        relayUrl = relay,
        deviceId = "device-$hostId",
        deviceToken = "token-$hostId",
        pairedAt = 1_000L,
        hostName = "host-$hostId",
    )

    // ---- 1. 加密 ---------------------------------------------------------------

    @Test
    fun `key derivation is reproducible and salt-dependent`() {
        val salt = Base64.getEncoder().encodeToString(ByteArray(16) { it.toByte() })
        val otherSalt = Base64.getEncoder().encodeToString(ByteArray(16) { (it + 1).toByte() })
        val a = AcctCrypto.deriveKey("correct horse", salt)
        val b = AcctCrypto.deriveKey("correct horse", salt)
        val c = AcctCrypto.deriveKey("correct horse", otherSalt)
        assertEquals(32, a.size)
        assertArrayEquals("同密码同盐必须得到同一把钥匙（换设备才能解开）", a, b)
        assertFalse("盐不同→钥匙必须不同", a.contentEquals(c))
    }

    @Test
    fun `sealed payload roundtrips and never leaks the token`() {
        val salt = Base64.getEncoder().encodeToString(ByteArray(16) { 7 })
        val key = AcctCrypto.deriveKey("correct horse", salt)
        val payload = AccountSync.build(listOf(pairing("h1")), mapOf("appearance" to "dark"))
        val sealed = AcctCrypto.seal(key, AccountSync.encode(payload))
        assertFalse("同步包里是密文，不能出现 deviceToken 明文", sealed.contains("token-h1"))
        val opened = AcctCrypto.open(key, sealed)
        assertNotNull(opened)
        val decoded = AccountSync.decode(opened!!)
        assertEquals(listOf(pairing("h1")), decoded?.pairings)
        assertEquals(mapOf("appearance" to "dark"), decoded?.settings)
    }

    @Test
    fun `wrong key or tampered payload cannot be opened`() {
        val salt = Base64.getEncoder().encodeToString(ByteArray(16) { 3 })
        val key = AcctCrypto.deriveKey("correct horse", salt)
        val other = AcctCrypto.deriveKey("wrong horse", salt)
        val sealed = AcctCrypto.seal(key, byteArrayOf(1, 2, 3))
        assertNull("错的密码不能解开同步包", AcctCrypto.open(other, sealed))
        val raw = Base64.getDecoder().decode(sealed)
        raw[raw.size - 1] = (raw[raw.size - 1] + 1).toByte()   // 篡改最后一个字节（GCM tag）
        assertNull("被篡改的密文必须解不开（GCM 会校验 tag）", AcctCrypto.open(key, Base64.getEncoder().encodeToString(raw)))
        assertNull(AcctCrypto.open(key, "not-base64"))
    }

    // ---- 2. 合并 ---------------------------------------------------------------

    @Test
    fun `pairing merge keeps local entries and appends remote-only ones`() {
        val local = listOf(pairing("h1", "wss://local:9443/ws"), pairing("h2"))
        val remote = listOf(pairing("h1", "wss://stale:9443/ws"), pairing("h3"))
        val merged = AccountSync.mergePairings(local, remote)
        assertEquals(listOf("h1", "h2", "h3"), merged.map { it.hostId })
        assertEquals("同 hostId 必须保留本机那份（本机的 relayUrl 才是最新的）", "wss://local:9443/ws", merged[0].relayUrl)
        assertEquals(2, local.size)
        assertTrue("远端多出来的配对要补进来", merged.any { it.hostId == "h3" })
    }

    @Test
    fun `settings merge is local-first and ignores unknown keys`() {
        val merged = AccountSync.mergeSettings(
            local = mapOf("appearance" to "dark"),
            remote = mapOf("appearance" to "light", "fontSize" to "large", "unknown-key" to "x"),
        )
        assertEquals("dark", merged["appearance"])
        assertEquals("large", merged["fontSize"])
        assertNull(merged["unknown-key"])
    }

    @Test
    fun `build only ships whitelisted settings`() {
        val payload = AccountSync.build(
            listOf(pairing("h1")),
            mapOf("appearance" to "dark", "fontSize" to "small", "speakDuringCall" to "true"),
        )
        assertEquals(setOf("appearance", "fontSize"), payload.settings.keys)
        assertEquals(AccountSync.VERSION, payload.version)

        // 下发方向：未知键要被忽略（老服务端/新客户端混用不至于崩）
        val decoded = AccountSync.decode(
            """{"version":1,"updatedAt":1,"pairings":[],"settings":{"appearance":"dark","future-key":"v"}}""".toByteArray(),
        )
        assertNotNull(decoded)
        assertEquals("dark", decoded?.settings?.get("appearance"))
    }

    @Test
    fun `payload decode tolerates unknown fields from newer clients`() {
        val decoded = AccountSync.decode("""{"version":99,"pairings":[],"settings":{},"extra":true}""".toByteArray())
        assertNotNull(decoded)
        assertTrue(decoded!!.pairings.isEmpty())
    }

    // ---- 3. 地址推导 -----------------------------------------------------------

    @Test
    fun `account base urls prefer the tls candidate`() {
        val candidates = listOf(
            "ws://10.215.35.72:9001/ws",
            "wss://10.215.35.72:9443/ws",
            "ws://47.97.28.110:10445/ws",
            "wss://47.97.28.110:9443/ws",
        )
        assertEquals("https://10.215.35.72:9443", AccountApi.tlsBaseOf(candidates))
        assertEquals("http://10.215.35.72:9001", AccountApi.plainBaseOf(candidates))
        assertNull("只有明文候选时不做账号请求（密码不能裸奔）", AccountApi.tlsBaseOf(listOf("ws://47.97.28.110:10445/ws")))
        assertNull(AccountApi.plainBaseOf(listOf("wss://47.97.28.110:9443/ws")))
    }
}
