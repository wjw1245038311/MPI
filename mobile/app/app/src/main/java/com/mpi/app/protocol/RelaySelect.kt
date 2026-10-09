package com.mpi.app.protocol

/**
 * 多通道选路（S4）—— 与 PWA 的 `lib/relay-select.ts` **同口径**；S6 起顺序规则调整。
 *
 * 规则：候选顺序 = **主机下发的 `relayUrls` 原序**（首个 = 首选）→ `lastGoodRelayUrl`（回落）
 * → 单值 `relayUrl`；去重去空。
 *
 * S6 起「**主机顺序优先**」：桌面改通道后手机重连即跟随（不再粘在「上次可用」那条上）；
 * `lastGoodRelayUrl` 退为回落点。重连取候选首位；配对时逐条尝试（超时降级由调用方控制）。
 */
object RelaySelect {

    /** 候选地址顺序（去空、去重；主机顺序在前，上次可用退为回落）。 */
    fun candidates(relayUrl: String?, relayUrls: List<String>, lastGoodRelayUrl: String?): List<String> {
        val ordered = LinkedHashSet<String>()
        fun push(raw: String?) {
            val url = raw?.trim().orEmpty()
            if (url.isNotEmpty()) ordered.add(url)
        }
        // S6：主机顺序优先（首个 = 首选）——「桌面选哪条、手机跟哪条」。
        relayUrls.forEach { push(it) }
        // 上次可用只作回落；主机列表缺失（旧记录）时它自然成为首位，S4 老行为不破。
        push(lastGoodRelayUrl)
        push(relayUrl)
        return ordered.toList()
    }

    /**
     * S4 缺口补齐（降级重试用）：候选顺序不变，但去掉**已经试过**的地址。
     * 看门狗每超时一次就换下一条（逐条短超时），直到候选耗尽。
     */
    fun remainingCandidates(
        relayUrl: String?,
        relayUrls: List<String>,
        lastGoodRelayUrl: String?,
        tried: List<String>,
    ): List<String> {
        val done = tried.map { it.trim() }.toSet()
        return candidates(relayUrl, relayUrls, lastGoodRelayUrl).filterNot { it in done }
    }

    /** 本次连接该用哪个地址：候选首位（= 主机首选；旧记录则回落上次可用）。 */
    fun pick(relayUrl: String, relayUrls: List<String>, lastGoodRelayUrl: String?): String =
        candidates(relayUrl, relayUrls, lastGoodRelayUrl).firstOrNull() ?: relayUrl

    /** [mergeHostRelayInfo] 的结果 —— 由调用方写回 [com.mpi.app.data.PairingRecord]。 */
    data class HostRelayMerge(val relayUrls: List<String>, val lastGoodRelayUrl: String?)

    /**
     * S6：把主机 `host.info` 下发的**有序**通道列表合并进本地记录。
     *
     * - 顺序以主机为准（首个 = 首选）；去空、去重。
     * - `lastGoodRelayUrl` 只表示「上次**降级**连上的地址」：本次连上主机首选（或无从判断且
     *   原标记就等于首选）就清掉它，否则保留 [connectedUrl]（作为下次回落的快速入口）。
     * - 主机没给有效列表时返回 null（**不动本地**）。
     */
    fun mergeHostRelayInfo(
        currentLastGood: String?,
        hostRelayUrls: List<String>,
        connectedUrl: String?,
    ): HostRelayMerge? {
        val ordered = LinkedHashSet<String>()
        hostRelayUrls.forEach {
            val url = it.trim()
            if (url.isNotEmpty()) ordered.add(url)
        }
        if (ordered.isEmpty()) return null
        val list = ordered.toList()
        val primary = list.first()
        val connected = connectedUrl?.trim().orEmpty()
        val degraded =
            if (connected.isNotEmpty()) connected != primary
            else currentLastGood?.trim().orEmpty() != primary
        val lastGood = if (degraded) connected.ifEmpty { currentLastGood } else null
        return HostRelayMerge(list, lastGood)
    }

    /** 通道的可读标签（只显示 host，不猜语义）——用于「当前通道」展示。 */
    fun label(url: String): String {
        val withoutScheme = url.substringAfter("://", url)
        val hostAndPath = withoutScheme.substringBefore('/')
        return hostAndPath.ifEmpty { url }
    }
}
