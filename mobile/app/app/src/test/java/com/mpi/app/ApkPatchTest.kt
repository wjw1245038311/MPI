package com.mpi.app

import com.mpi.app.data.ApkPatch
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.zip.DeflaterOutputStream

/**
 * 增量包（APK 差量）应用端：
 *  - 与 Node 侧 `scripts/make-apk-patch.mjs` 同一格式（服务端生成 → 这里应用）；
 *  - **必须**在合并后再核对完整包的 sha256（那是最后一道闸门）。
 */
class ApkPatchTest {

    // ---- 测试用打包工具（与服务端同样的格式） ----

    private fun writeIntLE(out: ByteArrayOutputStream, value: Int) {
        out.write(value and 0xff)
        out.write((value shr 8) and 0xff)
        out.write((value shr 16) and 0xff)
        out.write((value shr 24) and 0xff)
    }

    private fun buildPatch(newSize: Long, instructions: ByteArray, magic: String = "MPIPATCH1"): ByteArray {
        val deflated = ByteArrayOutputStream().apply {
            DeflaterOutputStream(this).use { it.write(instructions) }
        }.toByteArray()
        return ByteArrayOutputStream().apply {
            write(magic.toByteArray(Charsets.US_ASCII))
            for (i in 0 until 8) write(((newSize shr (8 * i)) and 0xff).toInt())
            write(deflated)
        }.toByteArray()
    }

    /** COPY(from,len) + ADD(bytes) + END。 */
    private fun instructions(
        copies: List<Pair<Int, Int>> = emptyList(),
        adds: List<ByteArray> = emptyList(),
    ): ByteArray {
        val out = ByteArrayOutputStream()
        copies.forEach { (from, len) ->
            out.write(1); writeIntLE(out, from); writeIntLE(out, len)
        }
        adds.forEach { bytes ->
            out.write(2); writeIntLE(out, bytes.size); out.write(bytes)
        }
        out.write(0)
        return out.toByteArray()
    }

    // ---- 正常路径 ----

    @Test
    fun `copy then add rebuilds the new file`() {
        val old = "abcdefghij".toByteArray()
        val patch = buildPatch(
            newSize = 7,
            instructions = instructions(copies = listOf(2 to 4), adds = listOf("XYZ".toByteArray())),
        )
        assertEquals("cdefXYZ", String(ApkPatch.apply(old, patch)))
    }

    @Test
    fun `a pure-copy patch reproduces a slice of the old file`() {
        val old = "0123456789".toByteArray()
        val patch = buildPatch(newSize = 4, instructions = instructions(copies = listOf(3 to 4)))
        assertEquals("3456", String(ApkPatch.apply(old, patch)))
    }

    @Test
    fun `a pure-add patch works with an empty old file`() {
        val patch = buildPatch(newSize = 5, instructions = instructions(adds = listOf("hello".toByteArray())))
        assertArrayEquals("hello".toByteArray(), ApkPatch.apply(ByteArray(0), patch))
    }

    @Test
    fun `binary content survives the round trip`() {
        val old = ByteArray(4096) { (it % 251).toByte() }
        val added = ByteArray(1000) { (255 - it % 256).toByte() }
        val patch = buildPatch(
            newSize = (old.size + added.size).toLong(),
            instructions = instructions(copies = listOf(0 to old.size), adds = listOf(added)),
        )
        val merged = ApkPatch.apply(old, patch)
        assertArrayEquals(old + added, merged)
    }

    // ---- 拒绝路径（任何一条失败都必须能回退到完整包） ----

    @Test
    fun `a foreign file is rejected`() {
        val patch = buildPatch(1, instructions(), magic = "NOTAPATCH")
        val error = runCatching { ApkPatch.apply(ByteArray(0), patch) }.exceptionOrNull()
        assertTrue(error is IOException)
    }

    @Test
    fun `copy beyond the old file is rejected`() {
        val old = ByteArray(4) { 1 }
        val patch = buildPatch(4, instructions(copies = listOf(2 to 4)))
        val error = runCatching { ApkPatch.apply(old, patch) }.exceptionOrNull()
        assertTrue(error is IOException)
    }

    @Test
    fun `an add shorter than declared is rejected`() {
        // ADD 声明 10 字节，实际只给了 3 字节：读取时必然撞到流尾
        val ins = ByteArrayOutputStream().apply {
            write(2)
            writeIntLE(this, 10)
            write("XYZ".toByteArray())
            write(0)
        }.toByteArray()
        val patch = buildPatch(newSize = 10, instructions = ins)
        val error = runCatching { ApkPatch.apply(ByteArray(0), patch) }.exceptionOrNull()
        assertTrue(error is IOException)
    }

    @Test
    fun `a size mismatch is rejected`() {
        val old = "abcdefghij".toByteArray()
        // 声明 10 字节，实际只写 7 字节
        val patch = buildPatch(10, instructions(copies = listOf(0 to 3), adds = listOf("XYZ".toByteArray())))
        val error = runCatching { ApkPatch.apply(old, patch) }.exceptionOrNull()
        assertTrue(error is IOException)
    }
}
