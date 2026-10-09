package com.mpi.app.protocol

/**
 * 多通道选路（S4）—— 与 PWA 的 `lib/relay-select.ts` **同口径**。
 *
 * 规则：候选顺序 = **上次可用的优先** → 票里 `relayUrls` 原序（局域网已由主机置顶）→ 单值 `relayUrl`；
 * 去重去空。重连取候选首位；配对时逐条尝试（超时降级由调用方控制）。
 */
object RelaySelect {

    /** 候选地址顺序（去空、去重、上次可用优先）。 */
    fun candidates(relayUrl: String?, relayUrls: List<String>, lastGoodRelayUrl: String?): List<String> {
        val ordered = LinkedHashSet<String>()
        fun push(raw: String?) {
            val url = raw?.trim().orEmpty()
            if (url.isNotEmpty()) ordered.add(url)
        }
        push(lastGoodRelayUrl)
        relayUrls.forEach { push(it) }
        push(relayUrl)
        return ordered.toList()
    }

    /** 本次连接该用哪个地址：上次可用的优先，否则候选首位。 */
    fun pick(relayUrl: String, relayUrls: List<String>, lastGoodRelayUrl: String?): String =
        candidates(relayUrl, relayUrls, lastGoodRelayUrl).firstOrNull() ?: relayUrl

    /** 通道的可读标签（只显示 host，不猜语义）——用于「当前通道」展示。 */
    fun label(url: String): String {
        val withoutScheme = url.substringAfter("://", url)
        val hostAndPath = withoutScheme.substringBefore('/')
        return hostAndPath.ifEmpty { url }
    }
}
