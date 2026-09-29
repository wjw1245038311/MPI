package com.mpi.app.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * E2E 帧的**二进制**编码（2026-09-30）——去掉 base64 的 33% 膨胀。
 *
 * 与主机 `src/main/remote/e2e-binary.ts` 逐字节一致（跨端向量见 `E2eBinaryTest`）：
 * ```
 *   [0]      版本 = 1
 *   [1]      头部长度 N（0..255）
 *   [2..2+N] 头部 JSON（UTF-8）：{"to":"device-x"} / {"from":"device-x"}（路由元数据，中继要读）
 *   [2+N..]  12B nonce ‖ 密文 ‖ 16B tag
 * ```
 *
 * **能力协商**：只有两端都在配对时声明了 [E2E_BINARY_CAP]，才切到二进制；否则继续走 JSON 版（老端不变）。
 * 这是纯编码改动，密码学一行没动（AES-256-GCM 仍是同一套）。
 */
const val E2E_BINARY_VERSION: Int = 1
const val E2E_BINARY_CAP: String = "e2e-bin"

/** 一条二进制 E2E 帧（头部 + nonce + 密文‖tag）。 */
class BinaryE2EFrame(val header: JsonObject, val nonce: ByteArray, val body: ByteArray)

/** 拼一条二进制帧（headerJson 必须是合法 JSON 对象文本且 ≤255 字节）。 */
fun encodeBinaryFrame(headerJson: String, nonce: ByteArray, body: ByteArray): ByteArray {
    val head = headerJson.toByteArray(Charsets.UTF_8)
    require(head.size <= 255) { "E2E 帧头部过大" }
    val out = ByteArray(2 + head.size + nonce.size + body.size)
    out[0] = E2E_BINARY_VERSION.toByte()
    out[1] = head.size.toByte()
    head.copyInto(out, 2)
    nonce.copyInto(out, 2 + head.size)
    body.copyInto(out, 2 + head.size + nonce.size)
    return out
}

/** 解析一条二进制帧；不是本格式 → null（调用方忽略，别当垃圾解）。 */
fun decodeBinaryFrame(bytes: ByteArray): BinaryE2EFrame? {
    if (bytes.size < 2 || bytes[0].toInt() != E2E_BINARY_VERSION) return null
    val headerLength = bytes[1].toInt() and 0xff
    if (bytes.size < 2 + headerLength + 12 + 16) return null
    val header = runCatching {
        Json.parseToJsonElement(String(bytes, 2, headerLength, Charsets.UTF_8)).jsonObject
    }.getOrNull() ?: return null
    val nonceStart = 2 + headerLength
    return BinaryE2EFrame(
        header = header,
        nonce = bytes.copyOfRange(nonceStart, nonceStart + 12),
        body = bytes.copyOfRange(nonceStart + 12, bytes.size),
    )
}

/** 远端是否声明支持二进制帧（能力协商）。 */
fun supportsBinaryFrames(caps: JsonElement?): Boolean = runCatching {
    caps?.let { element ->
        (element as? kotlinx.serialization.json.JsonArray)?.any { it.toString().trim('"') == E2E_BINARY_CAP } == true
    } ?: false
}.getOrDefault(false)
