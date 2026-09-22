package com.mpi.app.protocol

import java.security.MessageDigest
import java.security.SecureRandom
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

/**
 * 设备身份 —— 与 PWA 的 mobile/pwa/src/lib/device-identity.ts 逐字节一致。
 *
 * ⚠️ 兼容性关键：`deviceId` 由 SPKI PEM 字符串的 SHA-256 得出，
 * 所以 PEM 的换行、padding、DER 前缀都必须与 TS 侧完全相同。
 */

/** 固定 SPKI DER 前缀（SEQUENCE{SEQUENCE{OID 1.3.101.112}, BITSTRING}）。 */
private val ED25519_SPKI_PREFIX = byteArrayOf(
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
)

private const val X25519_INFO = "mpi-device-x25519"

data class DeviceIdentity(
    /** "device-<sha256(SPKI PEM) base64url[:24]>" —— 与主机端 deviceIdFor() 一致。 */
    val deviceId: String,
    /** 公钥的 SPKI PEM（主机端据此验签）。 */
    val publicKeyPem: String,
    /** X25519 公钥（raw 32B，base64url），用于 E2E 密钥协商。 */
    val x25519PubB64u: String,
    /** X25519 私钥：由 Ed25519 种子确定性派生，不引入种子之外的新秘密。 */
    val x25519PrivB64u: String,
    /** 可持久化的 Ed25519 种子（base64url，32 字节）。 */
    val seedB64u: String,
) {
    /** text → base64url 签名（无 padding），与 identity.signText 一致。 */
    fun signText(text: String): String =
        Base64Url.encode(ed25519Sign(Base64Url.decode(seedB64u), text.toByteArray(Charsets.UTF_8)))
}

/** 由 Ed25519 种子确定性派生 X25519 私钥（单种子设备）。 */
fun deriveX25519Priv(ed25519Seed: ByteArray): ByteArray =
    Hkdf.sha256(ed25519Seed, ByteArray(0), X25519_INFO.toByteArray(Charsets.UTF_8), 32)

/** 标准 PEM（每行 64 字符）——与 Node 的 spki/pem 导出一致。 */
fun ed25519SpkiPem(publicKey32: ByteArray): String {
    val der = ED25519_SPKI_PREFIX + publicKey32
    val b64 = java.util.Base64.getEncoder().encodeToString(der)
    return "-----BEGIN PUBLIC KEY-----\n${b64.chunked(64).joinToString("\n")}\n-----END PUBLIC KEY-----\n"
}

fun deviceIdFor(publicKeyPem: String): String {
    val hash = MessageDigest.getInstance("SHA-256").digest(publicKeyPem.toByteArray(Charsets.UTF_8))
    return "device-" + Base64Url.encode(hash).take(24)
}

fun ed25519Sign(seed: ByteArray, message: ByteArray): ByteArray {
    val signer = Ed25519Signer()
    signer.init(true, Ed25519PrivateKeyParameters(seed, 0))
    signer.update(message, 0, message.size)
    return signer.generateSignature()
}

/** 新建身份；传入 seedB64u 则从已存种子恢复。 */
fun createDeviceIdentity(seedB64u: String? = null): DeviceIdentity {
    val seed = if (seedB64u != null) Base64Url.decode(seedB64u) else randomSeedBytes()
    require(seed.size == 32) { "invalid Ed25519 seed length" }

    val publicKey = Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
    val pem = ed25519SpkiPem(publicKey)
    val x25519Priv = deriveX25519Priv(seed)
    return DeviceIdentity(
        deviceId = deviceIdFor(pem),
        publicKeyPem = pem,
        x25519PubB64u = Base64Url.encode(X25519.publicKeyFromPrivate(x25519Priv)),
        x25519PrivB64u = Base64Url.encode(x25519Priv),
        seedB64u = Base64Url.encode(seed),
    )
}

/** 全新身份的随机 Ed25519 种子（base64url，32 字节）。 */
fun randomSeedB64u(): String = Base64Url.encode(randomSeedBytes())

private fun randomSeedBytes(): ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }
