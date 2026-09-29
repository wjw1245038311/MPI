package com.mpi.app.data

import com.mpi.app.protocol.Hkdf
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 附件载荷的**应用层加密**（v1，安卓侧）——必须与主机 `src/main/remote/attachment-crypto.ts`
 * 逐字节一致（跨端测试向量见 `DirectAttachmentLogicTest`）。
 *
 * 为什么要有它：国内链路按 TLS 握手指纹给连接注入 RST（安卓 OkHttp 517B hello 会被掐），
 * 所以「手机不装 Tailscale」时附件只能走明文 HTTP；保密性与完整性改由这一层保证：
 *
 *   密钥 = HKDF-SHA256(ikm = E2E 会话密钥（配对时协商，从不过网）, salt = 附件令牌,
 *                       info = "mpi-attachment-v1|<up|down>|<附件名>")
 *   帧   = nonce(12) ‖ AES-256-GCM 密文 ‖ tag(16)
 *   AAD  = "v1|<up|down>|<附件名>|<offset>|<明文长度>"
 *
 * 令牌会随明文传输，所以它只当 salt/命名空间；AAD 里的方向与偏移量让中间人无法重排分片、
 * 也无法把上行密文回放成下行（改了任一字段 GCM 校验就失败）。
 */
object AttachmentCrypto {
    /** 客户端用它声明本次载荷已加密（不带则按明文处理，与旧客户端共存）。 */
    const val HEADER = "X-MPI-Enc"
    const val VERSION = "v1"

    /** nonce(12) + tag(16) 的固定开销；明文长度 = 帧长 - 28。 */
    const val OVERHEAD = 28

    private const val NONCE_LENGTH = 12
    private const val TAG_BITS = 128

    const val UP = "up"
    const val DOWN = "down"

    fun infoString(direction: String, name: String): String = "mpi-attachment-v1|$direction|$name"

    fun aad(direction: String, name: String, offset: Long, plaintextLength: Int): String =
        "$VERSION|$direction|$name|$offset|$plaintextLength"

    /** HKDF-SHA256 → 32B 密钥。注意 ikm 是**会话密钥**（不是 token）。 */
    fun deriveKey(sessionKey: ByteArray, token: String, direction: String, name: String): ByteArray =
        Hkdf.sha256(
            sessionKey,
            token.toByteArray(Charsets.UTF_8),
            infoString(direction, name).toByteArray(Charsets.UTF_8),
            32,
        )

    /** 明文 → 帧。 */
    fun encrypt(key: ByteArray, plaintext: ByteArray, aad: String): ByteArray {
        val nonce = ByteArray(NONCE_LENGTH).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
        return nonce + cipher.doFinal(plaintext)
    }

    /** 帧 → 明文；被篡改 / AAD 不符 / 密钥不对 一律抛异常。 */
    fun decrypt(key: ByteArray, frame: ByteArray, aad: String): ByteArray {
        require(frame.size >= OVERHEAD) { "附件帧太短（${frame.size} 字节）" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(TAG_BITS, frame.copyOfRange(0, NONCE_LENGTH)),
        )
        cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(frame, NONCE_LENGTH, frame.size - NONCE_LENGTH)
    }
}
