package com.mpi.app.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * 协议 v1 envelope —— 与 mobile/shared/protocol.ts 的 `makeEnvelope` / `parseEnvelope`
 * 保持**同构**（字段名、校验规则、错误码一致）。
 *
 * ⚠️ 这是三端契约（Node 主机 / PWA / Android）。改这里必须同步改 TS 侧，
 * 否则解析行为会分叉（§12 回归要求）。
 */

const val REMOTE_PROTOCOL_VERSION = 1

/** 中继单帧上限，与 relay 的 MAX_FRAME_BYTES 一致。 */
const val MAX_ENVELOPE_BYTES = 2_000_000

/** 协议层错误；[code] 与 TS 侧 RemoteProtocolError.code 对应。 */
class RemoteProtocolException(val code: String, message: String) : Exception(message)

@Serializable
data class RemoteErrorPayload(
    val code: String,
    val message: String = "",
)

@Serializable
data class RemoteEnvelope(
    /** ⚠️ **必填、无默认值**：若给默认值，`encodeDefaults=false` 会把它省略，
     *  而主机端 parseEnvelope 会因 `v !== 1` 直接报 UNSUPPORTED_VERSION。 */
    val v: Int,
    val type: String,
    val sessionId: String,
    val sentAt: Long,
    val requestId: String? = null,
    val threadId: String? = null,
    val seq: Long? = null,
    val payload: JsonElement? = null,
    val error: RemoteErrorPayload? = null,
    /** 中继路由字段：host→device 必须带 `to`；中继给 device→host 的帧加 `from`。
     *  TS 侧作为额外键存在（不入 RemoteEnvelope 类型），Kotlin 侧显式建模以便发送。 */
    val to: String? = null,
    val from: String? = null,
)

object Envelope {
    /** 与 PWA 一致的宽松解析：忽略未知字段（协议演进时旧端不报错）。 */
    val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = false
    }

    fun make(
        type: String,
        sessionId: String,
        payload: JsonElement? = null,
        requestId: String? = null,
        threadId: String? = null,
        seq: Long? = null,
        to: String? = null,
        sentAt: Long = System.currentTimeMillis(),
    ): RemoteEnvelope = RemoteEnvelope(
        v = REMOTE_PROTOCOL_VERSION,
        type = type,
        sessionId = sessionId,
        sentAt = sentAt,
        requestId = requestId,
        threadId = threadId,
        seq = seq,
        payload = payload,
        to = to,
    )

    fun encode(envelope: RemoteEnvelope): String = json.encodeToString(RemoteEnvelope.serializer(), envelope)

    /**
     * 解析并校验；不合法时抛 [RemoteProtocolException]。
     * 校验项与 TS 的 parseEnvelope 一一对应（错误码也相同）。
     */
    fun parse(raw: String): RemoteEnvelope {
        if (raw.length > MAX_ENVELOPE_BYTES) {
            throw RemoteProtocolException("PAYLOAD_TOO_LARGE", "Remote message is too large")
        }
        val element = try {
            json.parseToJsonElement(raw)
        } catch (e: Exception) {
            throw RemoteProtocolException("INVALID_JSON", "Remote message is not valid JSON")
        }
        val obj = element as? JsonObject
            ?: throw RemoteProtocolException("INVALID_REQUEST", "Remote message must be an object")

        // 与 TS 的 parseEnvelope 对齐：**先看版本号**，缺失或不等于 1 都归为版本不符
        // （TS 里 `value.v !== 1` 对 undefined 同样成立）。
        val version = obj["v"]?.jsonPrimitive?.content?.toIntOrNull()
        if (version != REMOTE_PROTOCOL_VERSION) {
            throw RemoteProtocolException("UNSUPPORTED_VERSION", "Unsupported remote protocol version")
        }

        val envelope = try {
            json.decodeFromString(RemoteEnvelope.serializer(), raw)
        } catch (e: Exception) {
            throw RemoteProtocolException("INVALID_REQUEST", "Remote message is malformed: ${e.message}")
        }
        if (envelope.type.isEmpty() || envelope.type.length > 80) {
            throw RemoteProtocolException("INVALID_REQUEST", "Remote message type is invalid")
        }
        if (envelope.sessionId.isEmpty() || envelope.sessionId.length > 128) {
            throw RemoteProtocolException("INVALID_REQUEST", "Remote session id is invalid")
        }
        if (envelope.requestId != null && envelope.requestId.length > 128) {
            throw RemoteProtocolException("INVALID_REQUEST", "Remote request id is invalid")
        }
        if (envelope.threadId != null && envelope.threadId.length > 128) {
            throw RemoteProtocolException("INVALID_REQUEST", "Remote thread id is invalid")
        }
        if (envelope.to != null && envelope.to.length > 128) {
            throw RemoteProtocolException("INVALID_REQUEST", "Remote routing target is invalid")
        }
        return envelope
    }
}
