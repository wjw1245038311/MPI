package com.mpi.app

import com.mpi.app.protocol.Base64Url
import com.mpi.app.protocol.PairingLink
import com.mpi.app.protocol.PairingLinkException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M1-5：配对链接解析（纯逻辑）。
 *
 * 这段代码的输入来自**人手动粘贴**，所以畸形输入是常态而不是例外——
 * 报错必须能看懂（「配对码已过期」而不是「异常」）。
 */
class PairingLinkTest {

    private fun encode(json: String): String = Base64Url.encode(json.toByteArray(Charsets.UTF_8))

    private val validJson = """
        {"hostId":"host-abc","ticket":"ticket-123","relayUrl":"wss://relay.example:9443/ws",
         "hostName":"wei_jw 工作站","expiresAt":4102444800000}
    """.trimIndent()

    @Test
    fun `parses the mpi scheme link`() {
        val payload = PairingLink.parse("mpi://pair?payload=${encode(validJson)}")
        assertEquals("host-abc", payload.hostId)
        assertEquals("ticket-123", payload.ticket)
        assertEquals("wss://relay.example:9443/ws", payload.relayUrl)
        assertEquals("wei_jw 工作站", payload.hostName)
        assertEquals(4102444800000L, payload.expiresAt)
    }

    @Test
    fun `parses a bare payload pasted from the desktop panel`() {
        val payload = PairingLink.parse(encode(validJson))
        assertEquals("host-abc", payload.hostId)
        assertFalse(payload.isExpired())
    }

    @Test
    fun `tolerates surrounding whitespace and newlines`() {
        val payload = PairingLink.parse("  \n mpi://pair?payload=${encode(validJson)} \n ")
        assertEquals("ticket-123", payload.ticket)
    }

    @Test
    fun `accepts standard base64 alphabet as well as url safe`() {
        // 有人从别处复制可能得到 +/ 形式；两种都要认
        val standard = java.util.Base64.getEncoder().encodeToString(validJson.toByteArray())
        assertEquals("host-abc", PairingLink.parse(standard).hostId)
    }

    @Test
    fun `missing relay url and host name are optional`() {
        val payload = PairingLink.parse(encode("""{"hostId":"h","ticket":"t"}"""))
        assertNull("relayUrl 缺失由上层报错，解析层不抛", payload.relayUrl)
        assertNull(payload.hostName)
        assertEquals(0L, payload.expiresAt)
        assertFalse("没带过期时间就不判过期", payload.isExpired())
    }

    @Test
    fun `an expired ticket is detected locally for a friendlier message`() {
        val payload = PairingLink.parse(encode("""{"hostId":"h","ticket":"t","expiresAt":1000}"""))
        assertTrue(payload.isExpired(now = 2000))
        assertFalse(payload.isExpired(now = 500))
    }

    @Test
    fun `malformed inputs produce readable messages`() {
        val cases = mapOf(
            "" to "粘贴",
            "mpi://pair" to "payload",
            "mpi://pair?payload=" to "payload",
            "不是-base64!!!" to "base64",
            encode("[]") to "对象",
            encode("not json") to "JSON",
            encode("""{"ticket":"t"}""") to "hostId",
            encode("""{"hostId":"h"}""") to "ticket",
        )
        for ((input, expectedFragment) in cases) {
            try {
                PairingLink.parse(input)
                fail("应拒绝：$input")
            } catch (e: PairingLinkException) {
                assertTrue(
                    "「$input」的报错应包含「$expectedFragment」，实际：${e.message}",
                    e.message!!.contains(expectedFragment),
                )
            }
        }
    }

    @Test
    fun `a payload with a hash fragment still parses`() {
        val payload = PairingLink.parse("mpi://pair?payload=${encode(validJson)}#pair=x")
        assertEquals("host-abc", payload.hostId)
    }
}
