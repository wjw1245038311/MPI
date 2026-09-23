package com.mpi.app.protocol

/**
 * 桌面端生成的配对载荷 —— 字段与 PWA 的 `parsePairingLink` / `PairingPayload` 对齐。
 *
 * 链接形态有两种（都要支持）：
 * - `mpi://pair?payload=<base64url json>`
 * - 光秃秃的 base64url 载荷（桌面面板里那个「复制链接」文本框）
 */
data class PairingPayload(
    val hostId: String,
    val ticket: String,
    /** 中继 WSS 端点；没有它就无法配对。 */
    val relayUrl: String? = null,
    /** 桌面机器名，多设备列表用来区分主机。 */
    val hostName: String? = null,
    /** 过期时间戳（ms）；0 = 载荷里没带。 */
    val expiresAt: Long = 0,
) {
    /** 载荷自带过期时间且已过期。过期由桌面端/中继拒绝，这里提前给出更友好的提示。 */
    fun isExpired(now: Long = System.currentTimeMillis()): Boolean = expiresAt in 1..<now
}

class PairingLinkException(message: String) : Exception(message)

object PairingLink {

    /** 解析配对链接/载荷；不合法时抛 [PairingLinkException]（消息面向用户）。 */
    fun parse(input: String): PairingPayload {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) throw PairingLinkException("请粘贴配对链接")

        val raw = if (trimmed.startsWith(PAIR_SCHEME)) extractPayloadParam(trimmed) else trimmed
        if (raw.isEmpty()) throw PairingLinkException("配对链接里没有 payload")

        val json = try {
            val normalized = raw.replace('+', '-').replace('/', '_')
            Base64Url.decode(normalized).decodeToString()
        } catch (_: Exception) {
            throw PairingLinkException("配对链接格式不正确（base64 解不开）")
        }

        val obj = try {
            Envelope.json.parseToJsonElement(json)
        } catch (_: Exception) {
            throw PairingLinkException("配对链接内容不是合法 JSON")
        } as? kotlinx.serialization.json.JsonObject
            ?: throw PairingLinkException("配对链接内容不是对象")

        fun text(key: String): String? =
            obj[key]?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull() }
                ?.takeIf { it.isNotEmpty() }

        val hostId = text("hostId") ?: throw PairingLinkException("配对载荷缺少 hostId")
        val ticket = text("ticket") ?: throw PairingLinkException("配对载荷缺少 ticket")
        val expiresAt = text("expiresAt")?.toLongOrNull() ?: 0L

        return PairingPayload(
            hostId = hostId,
            ticket = ticket,
            relayUrl = text("relayUrl"),
            hostName = text("hostName"),
            expiresAt = expiresAt,
        )
    }

    /** 从 `mpi://pair?a=1&payload=xxx` 里取 payload 参数。 */
    private fun extractPayloadParam(link: String): String {
        val queryStart = link.indexOf('?')
        if (queryStart < 0) return ""
        val query = link.substring(queryStart + 1).substringBefore('#')
        for (pair in query.split('&')) {
            val separator = pair.indexOf('=')
            if (separator <= 0) continue
            if (pair.substring(0, separator) == "payload") {
                return pair.substring(separator + 1)
            }
        }
        return ""
    }

    private const val PAIR_SCHEME = "mpi://"
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull(): String? =
    if (this is kotlinx.serialization.json.JsonNull) null else content
