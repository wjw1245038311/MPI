package com.mpi.app

import com.mpi.app.ui.normalizePairLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** M4：扫码结果的链接归一化（纯函数）。桌面二维码发的是 `https://<relay>/#pair=…`。 */
class ScanLinkLogicTest {

    @Test
    fun `mpi pair links pass through`() {
        val link = "mpi://pair?payload=AbCd_123"
        assertEquals(link, normalizePairLink(link))
    }

    @Test
    fun `https hash links are converted to the pair scheme`() {
        assertEquals(
            "mpi://pair?payload=AbCd_123",
            normalizePairLink("https://relay.example.com/#pair=AbCd_123"),
        )
    }

    @Test
    fun `a bare payload is accepted`() {
        assertEquals("AbCd_1234567890xy", normalizePairLink("  AbCd_1234567890xy  "))
    }

    @Test
    fun `unrelated codes are rejected`() {
        assertNull(normalizePairLink(""))
        assertNull(normalizePairLink("https://example.com/"))
        assertNull(normalizePairLink("随便一句中文"))
        assertNull(normalizePairLink("short"))
    }
}
