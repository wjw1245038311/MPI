package com.mpi.app.protocol

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.Serializable

/**
 * 端到端加密帧 —— 与 PWA 的 mobile/pwa/src/lib/e2e-crypto.ts 逐字节一致。
 * 主机侧同方案实现在 src/main/remote/e2e-crypto.ts，三端由固定向量钉死。
 */

const val E2E_FRAME_VERSION = 1

/** info 串（§4.2）——必须与主机端逐字节相同。 */
fun e2eInfoString(hostId: String, deviceId: String): String = "mpi-mobile-v1|$hostId|$deviceId"

/** HKDF-SHA256 → 32B AES-256-GCM 密钥（空 salt，见 Hkdf 的说明）。 */
fun deriveAesKey(sharedSecret: ByteArray, hostId: String, deviceId: String): ByteArray =
    Hkdf.sha256(sharedSecret, ByteArray(0), e2eInfoString(hostId, deviceId).toByteArray(Charsets.UTF_8), 32)

const val GCM_NONCE_LENGTH = 12
private const val GCM_TAG_BITS = 128

/**
 * AES-256-GCM 加密。输出布局 `ciphertext ‖ 16B tag`（JCE 默认即此布局，与 WebCrypto 相同）。
 * nonce 可显式传入：固定 nonce 时结果确定，用于与 TS 实现互验（测试用）。
 */
fun aesGcmEncrypt(key: ByteArray, plaintext: ByteArray, nonce: ByteArray): ByteArray {
    require(key.size == 32) { "invalid AES-256 key length: ${key.size}" }
    require(nonce.size == GCM_NONCE_LENGTH) { "invalid GCM nonce length: ${nonce.size}" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, nonce))
    return cipher.doFinal(plaintext)
}

/** 解密；密文/标签/nonce 被篡改时抛异常。 */
fun aesGcmDecrypt(key: ByteArray, ciphertextWithTag: ByteArray, nonce: ByteArray): ByteArray {
    require(key.size == 32) { "invalid AES-256 key length: ${key.size}" }
    require(nonce.size == GCM_NONCE_LENGTH) { "invalid GCM nonce length: ${nonce.size}" }
    require(ciphertextWithTag.size > 16) { "E2E frame too short" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, nonce))
    return cipher.doFinal(ciphertextWithTag)
}

@Serializable
data class E2EFrame(
    val e: Int = E2E_FRAME_VERSION,
    /** 12 字节 nonce，base64url。 */
    val n: String,
    /** ciphertext ‖ 16B tag，base64url。 */
    val c: String,
)

/** 加密一段 JSON 明文为加密帧。 */
fun encryptFrame(key: ByteArray, plaintextJson: String, nonce: ByteArray = randomNonce()): E2EFrame {
    val ciphertext = aesGcmEncrypt(key, plaintextJson.toByteArray(Charsets.UTF_8), nonce)
    return E2EFrame(n = Base64Url.encode(nonce), c = Base64Url.encode(ciphertext))
}

/** 解密加密帧为明文 JSON；篡改时抛异常。 */
fun decryptFrame(key: ByteArray, frame: E2EFrame): String {
    val nonce = Base64Url.decode(frame.n)
    require(nonce.size == GCM_NONCE_LENGTH) { "invalid E2E nonce length" }
    val data = Base64Url.decode(frame.c)
    require(data.size >= 17) { "E2E frame too short" }
    return aesGcmDecrypt(key, data, nonce).toString(Charsets.UTF_8)
}

private fun randomNonce(): ByteArray = ByteArray(GCM_NONCE_LENGTH).also { java.security.SecureRandom().nextBytes(it) }
