package com.mpi.app

import com.mpi.app.protocol.E2E_BINARY_CAP
import com.mpi.app.protocol.decodeBinaryFrame
import com.mpi.app.protocol.encodeBinaryFrame
import com.mpi.app.protocol.supportsBinaryFrames
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E2E 二进制帧（去 base64 的 33% 膨胀）——**跨端逐字节钉死**。
 *
 * 这里用的是主机（TS）实现产出的**钉死向量**：Kotlin 侧编码同一组输入必须得到完全相同的字节，
 * 解码它必须能解回同一个明文。布局错一个字节的表现是「所有加密流量静默解不开」，现场极难归因，
 * 所以宁可钉一个十六进制常量。
 */
class E2eBinaryTest {

    private val key = ByteArray(32) { 0x11 }
    private val nonce = ByteArray(12) { (it + 1).toByte() }
    private val plaintext = """{"type":"thread.prompt"}"""
    private val frameHex =
        "01137b2266726f6d223a226465766963652d78227d0102030405060708090a0b0c" +
            "86dd18d61a13d08bbb2df53273f38369f993a1d7b1cb159b53addd35f4feb63bf13039eff047ef65"

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    @Test
    fun `encoding matches the reference implementation byte for byte`() {
        val body = gcmEncrypt(plaintext.toByteArray(Charsets.UTF_8), nonce)
        val encoded = encodeBinaryFrame("""{"from":"device-x"}""", nonce, body)
        assertEquals("与主机实现必须逐字节一致（跨端兼容的底线）", frameHex, hex(encoded))
    }

    @Test
    fun `decoding the reference frame yields the same plaintext`() {
        val decoded = decodeBinaryFrame(frameHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
        assertEquals("头部路由元数据要原样解出（中继靠它路由）", "device-x", decoded?.header?.get("from")?.toString()?.trim('"'))
        assertArrayEquals(nonce, decoded?.nonce)
        assertArrayEquals("解出的明文必须一致", plaintext.toByteArray(Charsets.UTF_8), gcmDecrypt(decoded!!.body, decoded.nonce))
    }

    @Test
    fun `malformed frames are rejected instead of decoded`() {
        assertNull("空", decodeBinaryFrame(ByteArray(0)))
        assertNull("版本不对", decodeBinaryFrame(byteArrayOf(2, 0) + ByteArray(40)))
        assertNull("头长超出", decodeBinaryFrame(byteArrayOf(1, 200.toByte()) + ByteArray(10)))
        assertNull("载荷太短", decodeBinaryFrame(byteArrayOf(1, 0) + ByteArray(20)))
        assertNull("头部不是合法 JSON", decodeBinaryFrame(byteArrayOf(1, 3) + "{x]".toByteArray() + ByteArray(40)))
    }

    @Test
    fun `capability negotiation only when both sides advertise it`() {
        assertTrue(supportsBinaryFrames(JsonArray(listOf(JsonPrimitive(E2E_BINARY_CAP)))))
        assertTrue(!supportsBinaryFrames(JsonArray(listOf(JsonPrimitive("other")))))
        assertTrue(!supportsBinaryFrames(null))
        assertTrue(!supportsBinaryFrames(Json.parseToJsonElement("{}")))
    }

    private fun gcmEncrypt(plain: ByteArray, iv: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return cipher.doFinal(plain)
    }

    private fun gcmDecrypt(body: ByteArray, iv: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return cipher.doFinal(body)
    }
}
