package com.mpi.app.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 本地存储的加密封装。
 *
 * 设计取舍：**把整个存储当一个加密卷**（而不是逐字段加密）——更简单、同样安全，
 * 且除了 Android Keystore 这一层，其余逻辑都能在 JVM 上单测。
 *
 * 封装格式（与 [RawKeySecretBox] 共用）：`iv(12B) ‖ ciphertext ‖ tag(16B)`，整体再 base64 落盘。
 */
interface SecretBox {
    fun seal(plaintext: ByteArray): ByteArray

    /** 密钥不对 / 数据被篡改时抛异常。 */
    fun open(sealed: ByteArray): ByteArray
}

internal object SealedFormat {
    const val IV_LENGTH = 12
    private const val TAG_BITS = 128
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    fun seal(key: SecretKey, plaintext: ByteArray, iv: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        return iv + cipher.doFinal(plaintext)
    }

    fun open(key: SecretKey, sealed: ByteArray): ByteArray {
        require(sealed.size > IV_LENGTH) { "加密数据长度不合法" }
        val iv = sealed.copyOfRange(0, IV_LENGTH)
        val body = sealed.copyOfRange(IV_LENGTH, sealed.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        return cipher.doFinal(body)
    }
}

/**
 * 固定密钥实现 —— 只用于**测试与本地诊断**，不要在真机存储上使用。
 * 它让「封装/解封 + 落盘 + 篡改检测」这套逻辑能脱离 Android 在 JVM 上验证。
 */
class RawKeySecretBox(key: ByteArray, private val random: SecureRandom = SecureRandom()) : SecretBox {
    private val secretKey: SecretKey = SecretKeySpec(key, "AES").also {
        require(key.size == 32) { "需要 32 字节 AES-256 密钥" }
    }

    override fun seal(plaintext: ByteArray): ByteArray {
        val iv = ByteArray(SealedFormat.IV_LENGTH).also { random.nextBytes(it) }
        return SealedFormat.seal(secretKey, plaintext, iv)
    }

    override fun open(sealed: ByteArray): ByteArray = SealedFormat.open(secretKey, sealed)
}

/**
 * 真机实现：密钥由 **Android Keystore** 生成并保管（不出安全硬件/不出应用沙箱），
 * 应用只能拿它做加解密，拿不到原始密钥字节。
 */
class AndroidKeystoreSecretBox(private val alias: String = DEFAULT_ALIAS) : SecretBox {

    override fun seal(plaintext: ByteArray): ByteArray {
        val iv = ByteArray(SealedFormat.IV_LENGTH).also { SecureRandom().nextBytes(it) }
        return SealedFormat.seal(secretKey(), plaintext, iv)
    }

    override fun open(sealed: ByteArray): ByteArray = SealedFormat.open(secretKey(), sealed)

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"

        /** 换别名 = 丢弃旧数据（旧密钥解不开新卷）。 */
        const val DEFAULT_ALIAS = "mpi-mobile-store"
    }
}
