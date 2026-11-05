package com.mpi.app.data

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * 账号同步包的**客户端加密**（纯 JVM 可测）。
 *
 * 为什么要自己加密（2026-11-05 用户决定）：同步包里装着 `deviceToken`——那是能冒充本机
 * 手机的钥匙。服务器（我自己的 ECS）**只能看到密文**：
 *
 *   密钥 = PBKDF2-SHA256(密码, kdfSalt)      ← kdfSalt 由服务端下发（登录时给）
 *   密文 = AES-256-GCM(密钥, iv, 明文)       ← iv 每次随机，附在密文前面
 *
 * 换设备/重装时输入同一密码即可重新导出同一把钥匙——所以它可携带，而 AndroidKeyStore
 * 那份（[SecretBox]）不可携带（卸载即失，这是它存在的意义）。
 *
 * 参数固定写死在协议里：迭代次数一改，老客户端就解不开新包，所以两边必须一致。
 */
object AcctCrypto {
    /** 协议版本（服务端不解析，客户端按它决定参数）。 */
    const val VERSION = 1

    /** PBKDF2 迭代次数（与桌面/PWA 必须一致；手机上一轮约 100–200ms，可接受）。 */
    const val ITERATIONS = 210_000

    private const val KEY_BITS = 256
    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val KDF = "PBKDF2WithHmacSHA256"

    private val random = SecureRandom()

    /** 密码 + 服务端下发的 kdfSalt → 32 字节 AES 密钥。 */
    fun deriveKey(password: String, kdfSaltB64: String): ByteArray {
        val salt = java.util.Base64.getDecoder().decode(kdfSaltB64)
        val spec = PBEKeySpec(password.toCharArray(), salt, ITERATIONS, KEY_BITS)
        return try {
            SecretKeyFactory.getInstance(KDF).generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }

    /** 明文 → base64(iv ‖ ciphertext+tag)。 */
    fun seal(key: ByteArray, plaintext: ByteArray): String {
        val iv = ByteArray(IV_BYTES).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        val body = cipher.doFinal(plaintext)
        return java.util.Base64.getEncoder().encodeToString(iv + body)
    }

    /**
     * base64(iv ‖ ciphertext+tag) → 明文。
     *
     * 密钥不对 / 数据被改 / 格式坏 → 返回 null（调用方当成「同步包解不开」处理，
     * 常见原因是换了账号或改了密码）。**不抛异常**：这是网络+文件路径，异常会一路冒到界面。
     */
    fun open(key: ByteArray, payloadB64: String): ByteArray? {
        return try {
            val raw = java.util.Base64.getDecoder().decode(payloadB64)
            if (raw.size <= IV_BYTES) return null
            val iv = raw.copyOfRange(0, IV_BYTES)
            val body = raw.copyOfRange(IV_BYTES, raw.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.doFinal(body)
        } catch (_: Exception) {
            null
        }
    }
}
