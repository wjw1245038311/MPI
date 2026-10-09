package com.mpi.app

import com.mpi.app.protocol.RelaySelect
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * S4 多通道选路（与 PWA 的 relay-select 同口径）：
 * 候选顺序 = 上次可用 → 票序 → 单值；去重去空；重连取首位。
 */
class RelaySelectTest {

    @Test
    fun candidatesPutLastGoodFirstThenTicketOrderThenSingle() {
        val list = RelaySelect.candidates(
            relayUrl = "ws://c/ws",
            relayUrls = listOf("ws://a/ws", "ws://b/ws"),
            lastGoodRelayUrl = "ws://b/ws",
        )
        assertEquals(listOf("ws://b/ws", "ws://a/ws", "ws://c/ws"), list)
    }

    @Test
    fun candidatesDedupeAndTrimAndDropBlanks() {
        assertEquals(listOf("ws://a/ws"), RelaySelect.candidates("ws://a/ws", listOf("ws://a/ws"), null))
        assertEquals(emptyList<String>(), RelaySelect.candidates("", listOf("", "   "), null))
        assertEquals(listOf("ws://a/ws"), RelaySelect.candidates(" ws://a/ws ", emptyList(), null))
    }

    @Test
    fun candidatesKeepLastGoodEvenIfNotInTicket() {
        // 上次连上的地址即使已不在票里也先试它（可能只是桌面端改了票的顺序）
        val list = RelaySelect.candidates("ws://c/ws", listOf("ws://a/ws"), "ws://gone/ws")
        assertEquals(listOf("ws://gone/ws", "ws://a/ws", "ws://c/ws"), list)
    }

    @Test
    fun pickPrefersLastGoodThenFirstCandidate() {
        assertEquals("ws://b/ws", RelaySelect.pick("ws://c/ws", listOf("ws://a/ws"), "ws://b/ws"))
        assertEquals("ws://a/ws", RelaySelect.pick("ws://c/ws", listOf("ws://a/ws"), null))
        assertEquals("ws://c/ws", RelaySelect.pick("ws://c/ws", emptyList(), null))
    }

    @Test
    fun labelShowsHostOnly() {
        assertEquals("192.168.1.9:9001", RelaySelect.label("ws://192.168.1.9:9001/ws"))
        assertEquals("relay.whomidas.cn", RelaySelect.label("wss://relay.whomidas.cn/ws"))
        assertEquals("", RelaySelect.label(""))
    }
}
