package com.mpi.app

import com.mpi.app.protocol.RelaySelect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * S4 多通道选路（与 PWA 的 relay-select 同口径），S6 起顺序规则调整：
 * 候选顺序 = 主机 relayUrls 原序 → lastGood（回落）→ 单值；去重去空；重连取首位。
 * 另有 [RelaySelect.mergeHostRelayInfo]：host.info 列表合并（顺序以主机为准；lastGood 只在降级时保留）。
 */
class RelaySelectTest {

    @Test
    fun candidatesPutHostOrderFirstThenLastGoodThenSingle() {
        val list = RelaySelect.candidates(
            relayUrl = "ws://c/ws",
            relayUrls = listOf("ws://a/ws", "ws://b/ws"),
            lastGoodRelayUrl = "ws://b/ws",
        )
        // lastGood 已在主机列表里 → 不重复；单值补末尾
        assertEquals(listOf("ws://a/ws", "ws://b/ws", "ws://c/ws"), list)
    }

    @Test
    fun candidatesDedupeAndTrimAndDropBlanks() {
        assertEquals(listOf("ws://a/ws"), RelaySelect.candidates("ws://a/ws", listOf("ws://a/ws"), null))
        assertEquals(emptyList<String>(), RelaySelect.candidates("", listOf("", "   "), null))
        assertEquals(listOf("ws://a/ws"), RelaySelect.candidates(" ws://a/ws ", emptyList(), null))
    }

    @Test
    fun candidatesKeepLastGoodAsFallbackAfterHostOrder() {
        // 不在主机列表里的上次可用退为回落点，但仍先于单值字段
        val list = RelaySelect.candidates("ws://c/ws", listOf("ws://a/ws"), "ws://gone/ws")
        assertEquals(listOf("ws://a/ws", "ws://gone/ws", "ws://c/ws"), list)
        // 旧记录没有 relayUrls → 保留 S4 的「上次可用优先」
        assertEquals(listOf("ws://b/ws", "ws://c/ws"), RelaySelect.candidates("ws://c/ws", emptyList(), "ws://b/ws"))
    }

    @Test
    fun pickPrefersHostPrimaryOverLastGood() {
        // S6：桌面改了顺序 → 手机重连即跟随
        assertEquals("ws://a/ws", RelaySelect.pick("ws://c/ws", listOf("ws://a/ws"), "ws://b/ws"))
        assertEquals("ws://b/ws", RelaySelect.pick("ws://c/ws", emptyList(), "ws://b/ws"))
        assertEquals("ws://c/ws", RelaySelect.pick("ws://c/ws", emptyList(), null))
    }

    @Test
    fun mergeHostRelayInfoTakesHostOrderAndKeepsLastGoodOnlyWhenDegraded() {
        // 直连主机首选成功 → 没有降级，清掉回落点
        assertEquals(
            RelaySelect.HostRelayMerge(listOf("ws://ecs/ws", "ws://cf/ws"), null),
            RelaySelect.mergeHostRelayInfo("ws://cf/ws", listOf("ws://ecs/ws", "ws://cf/ws"), "ws://ecs/ws"),
        )
        // 本次连的是次选（发生过降级） → 记为回落点
        assertEquals(
            RelaySelect.HostRelayMerge(listOf("ws://ecs/ws", "ws://cf/ws"), "ws://cf/ws"),
            RelaySelect.mergeHostRelayInfo("ws://old/ws", listOf("ws://ecs/ws", "ws://cf/ws"), "ws://cf/ws"),
        )
        // 没有 connectedUrl：lastGood === 主机首选 → 也清
        assertNull(RelaySelect.mergeHostRelayInfo("ws://ecs/ws", listOf("ws://ecs/ws"), null)?.lastGoodRelayUrl)
        // 主机没给有效列表 → null（不动本地）
        assertNull(RelaySelect.mergeHostRelayInfo("ws://cf/ws", listOf("", "   "), "ws://ecs/ws"))
        // 去重去空，顺序保持
        assertEquals(
            listOf("ws://a/ws"),
            RelaySelect.mergeHostRelayInfo(null, listOf(" ws://a/ws ", "ws://a/ws", ""), null)?.relayUrls,
        )
    }

    @Test
    fun labelShowsHostOnly() {
        assertEquals("192.168.1.9:9001", RelaySelect.label("ws://192.168.1.9:9001/ws"))
        assertEquals("relay.whomidas.cn", RelaySelect.label("wss://relay.whomidas.cn/ws"))
        assertEquals("", RelaySelect.label(""))
    }
}
