package com.mpi.app.protocol

import java.util.Base64

/**
 * base64url（无 padding）—— 与 PWA 的 `toBase64Url` / `fromBase64Url`
 * （mobile/pwa/src/lib/device-identity.ts）行为一致。
 *
 * 注意：`java.util.Base64` 的 URL 解码器接受无 padding 输入，所以 encode 去 padding、
 * decode 直接吃两边的输出即可。
 */
object Base64Url {
    private val encoder: Base64.Encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder: Base64.Decoder = Base64.getUrlDecoder()

    fun encode(bytes: ByteArray): String = encoder.encodeToString(bytes)

    fun decode(value: String): ByteArray = decoder.decode(value)
}
