package com.mpi.app.protocol

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * HKDF-SHA256（RFC 5869）—— 与 TS 侧 `@noble/hashes/hkdf` 的调用逐字节一致。
 *
 * ⚠️ 与 noble 的对齐要点：TS 侧传的是 `new Uint8Array(0)`（空 salt）。
 * Java 的 Mac 不接受空密钥，这里把空 salt 归一成 32 字节全零——
 * 两者结果相同，因为 HMAC 的密钥不足一个 block（64 字节）时会补零，
 * 空密钥与 32 字节全零密钥最终都补成 64 字节全零。
 * 该等价性由 E2eCryptoVectorTest 的钉死向量（af724d…/42ba6d…）实测确认。
 */
object Hkdf {
    private const val HASH_LEN = 32
    private const val ALGORITHM = "HmacSHA256"

    fun sha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length > 0) { "invalid HKDF length" }
        require(length <= 255 * HASH_LEN) { "HKDF length too large" }

        val mac = Mac.getInstance(ALGORITHM)
        val saltKey = if (salt.isEmpty()) ByteArray(HASH_LEN) else salt

        // extract：PRK = HMAC(salt, ikm)
        mac.init(SecretKeySpec(saltKey, ALGORITHM))
        val prk = mac.doFinal(ikm)

        // expand：T(i) = HMAC(PRK, T(i-1) || info || i)
        mac.init(SecretKeySpec(prk, ALGORITHM))
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var position = 0
        var counter = 1
        while (position < length) {
            mac.reset()
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val chunk = minOf(previous.size, length - position)
            System.arraycopy(previous, 0, out, position, chunk)
            position += chunk
            counter++
        }
        return out
    }
}
