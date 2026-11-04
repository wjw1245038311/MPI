package com.mpi.app

import com.mpi.app.data.ApkPatch
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.zip.DeflaterOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 流式增量合并（`ApkPatch.applyStreaming`）。
 *
 * 为什么单独测：这是「APK 变大后不能 OOM」的保证。旧实现要 3×APK 的内存，
 * 这里必须是 O(64KB)，且长度/越界检查一个都不能少。
 */
class ApkPatchStreamingTest {

    private fun writeIntLE(out: java.io.OutputStream, value: Int) {
        out.write(value and 0xff)
        out.write((value shr 8) and 0xff)
        out.write((value shr 16) and 0xff)
        out.write((value shr 24) and 0xff)
    }

    /** 与 `scripts/make-apk-patch.mjs` 一致的格式。 */
    private fun buildPatch(newSize: Long, block: (java.io.OutputStream) -> Unit): ByteArray {
        val out = ByteArrayOutputStream()
        out.write("MPIPATCH1".toByteArray(Charsets.US_ASCII))
        for (i in 0 until 8) {
            out.write(((newSize shr (8 * i)) and 0xffL).toInt())
        }
        val deflate = DeflaterOutputStream(out)
        block(deflate)
        deflate.close()
        return out.toByteArray()
    }

    private fun copyOp(out: java.io.OutputStream, offset: Int, length: Int) {
        out.write(1)
        writeIntLE(out, offset)
        writeIntLE(out, length)
    }

    private fun addOp(out: java.io.OutputStream, bytes: ByteArray) {
        out.write(2)
        writeIntLE(out, bytes.size)
        out.write(bytes)
    }

    private fun tempFile(name: String, bytes: ByteArray): File =
        File.createTempFile(name, ".bin").apply { writeBytes(bytes); deleteOnExit() }

    @Test
    fun `copy plus add rebuilds the new package on disk`() {
        val old = ByteArray(200_000) { (it % 251).toByte() }
        val tail = "MPI 新版本尾部".toByteArray(Charsets.UTF_8)
        val new = old + tail
        val patch = buildPatch(new.size.toLong()) { ops ->
            copyOp(ops, 0, old.size)
            addOp(ops, tail)
            ops.write(0)
        }
        val outFile = File.createTempFile("merged", ".apk").apply { deleteOnExit() }
        ApkPatch.applyStreaming(tempFile("old", old), tempFile("patch", patch), outFile)
        assertArrayEquals(new, outFile.readBytes())
    }

    @Test
    fun `interior copies keep their offsets`() {
        val old = ByteArray(50_000) { (it % 97).toByte() }
        val new = old.copyOfRange(10_000, 40_000) + old.copyOfRange(0, 5_000)
        val patch = buildPatch(new.size.toLong()) { ops ->
            copyOp(ops, 10_000, 30_000)
            copyOp(ops, 0, 5_000)
            ops.write(0)
        }
        val outFile = File.createTempFile("merged", ".apk").apply { deleteOnExit() }
        ApkPatch.applyStreaming(tempFile("old", old), tempFile("patch", patch), outFile)
        assertArrayEquals(new, outFile.readBytes())
    }

    @Test
    fun `copy beyond the old package is rejected`() {
        val old = ByteArray(1_000) { 1 }
        val patch = buildPatch(2_000L) { ops ->
            copyOp(ops, 900, 2_000) // 越界
            ops.write(0)
        }
        val outFile = File.createTempFile("merged", ".apk").apply { deleteOnExit() }
        val failure = runCatching { ApkPatch.applyStreaming(tempFile("old", old), tempFile("patch", patch), outFile) }
        assertTrue(failure.isFailure)
        assertTrue(failure.exceptionOrNull() is IOException)
    }

    @Test
    fun `size mismatch between header and instructions is rejected`() {
        val old = ByteArray(100)
        val patch = buildPatch(999L) { ops ->
            copyOp(ops, 0, 100)
            ops.write(0)
        }
        val outFile = File.createTempFile("merged", ".apk").apply { deleteOnExit() }
        assertTrue(
            runCatching { ApkPatch.applyStreaming(tempFile("old", old), tempFile("patch", patch), outFile) }
                .isFailure,
        )
    }

    @Test
    fun `foreign magic is rejected`() {
        val bogus = "NOTAPATCH!".toByteArray(Charsets.US_ASCII) + ByteArray(8)
        val outFile = File.createTempFile("merged", ".apk").apply { deleteOnExit() }
        assertTrue(
            runCatching { ApkPatch.applyStreaming(tempFile("old", ByteArray(10)), tempFile("patch", bogus), outFile) }
                .isFailure,
        )
    }
}
