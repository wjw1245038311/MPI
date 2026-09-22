package com.mpi.app.protocol

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters

/**
 * X25519（RFC 7748）—— 与 Node `crypto.diffieHellman` / noble 的 `x25519.getSharedSecret` 一致。
 *
 * 用 BouncyCastle 而非 JDK：Android 对 X25519 的原生支持随版本而异（且部分 ROM 有差异），
 * BC 是纯 Java 实现，跨版本结果稳定。见 docs/MOBILE-NATIVE-DESIGN.md §2.4。
 */
object X25519 {
    /** 基点 u=9，其余 31 字节为 0。 */
    private val BASE_POINT: ByteArray = ByteArray(32).also { it[0] = 9.toByte() }

    fun sharedSecret(privateKey: ByteArray, theirPublicKey: ByteArray): ByteArray {
        require(privateKey.size == 32) { "invalid X25519 private key length: ${privateKey.size}" }
        require(theirPublicKey.size == 32) { "invalid X25519 public key length: ${theirPublicKey.size}" }
        val agreement = X25519Agreement()
        agreement.init(X25519PrivateKeyParameters(privateKey, 0))
        val out = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(X25519PublicKeyParameters(theirPublicKey, 0), out, 0)
        return out
    }

    /** pub = scalarMult(priv, base point)。 */
    fun publicKeyFromPrivate(privateKey: ByteArray): ByteArray = sharedSecret(privateKey, BASE_POINT)

    // ---- base64url 便捷包装（协议层实际使用的形态）----

    fun sharedSecretB64u(privateKeyB64u: String, theirPublicKeyB64u: String): ByteArray =
        sharedSecret(Base64Url.decode(privateKeyB64u), Base64Url.decode(theirPublicKeyB64u))

    fun publicKeyB64u(privateKeyB64u: String): String =
        Base64Url.encode(publicKeyFromPrivate(Base64Url.decode(privateKeyB64u)))
}
