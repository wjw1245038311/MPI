package com.mpi.app.data

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.util.zip.InflaterInputStream

/**
 * MPI 增量包（APK 差量更新）的**应用端**。
 *
 * 为什么不用标准 bsdiff/bspatch：那需要 bzip2 解压，而 Android 端没有内置 bzip2，
 * 引 `commons-compress` 又要多打一个库进包。这里定义自己的格式，压缩用 JDK 自带的
 * Deflate——服务端（Node `zlib`）与客户端用同一套，代价是压缩率略低于 bzip2。
 *
 * 文件格式（v1，全部小端）：
 * ```
 *  0    magic "MPIPATCH1"            (9 B)
 *  9    newSize                      (8 B, long)
 *  17   deflate(指令流)               (到文件尾)
 * ```
 * 指令流：
 * ```
 *   0x00 END
 *   0x01 COPY  srcOffset(i32) len(i32)   ← 从旧包里搬一段
 *   0x02 ADD   len(i32) bytes(len)       ← 直接追加新字节
 * ```
 *
 * 安全：所有偏移/长度都做边界检查；合并结果由调用方再核对 **sha256 是否等于完整包**
 * （这样即使增量包被篡改或基线不匹配，也会在安装前被拦下）。
 */
object ApkPatch {

    private val MAGIC = "MPIPATCH1".toByteArray(Charsets.US_ASCII)
    private const val HEADER_SIZE = 17

    private const val OP_END = 0
    private const val OP_COPY = 1
    private const val OP_ADD = 2

    /** 上限：512MB，防止恶意/损坏的头部导致巨额分配。 */
    private const val MAX_NEW_SIZE = 512L * 1024 * 1024

    /** 旧包 + 增量包 → 新包。任何不合法都抛 [IOException]，调用方回退下完整包。 */
    fun apply(old: ByteArray, patch: ByteArray): ByteArray {
        if (patch.size <= HEADER_SIZE) throw IOException("增量包不完整")
        for (i in MAGIC.indices) {
            if (patch[i] != MAGIC[i]) throw IOException("不是 MPI 增量包")
        }
        val newSize = readLongLE(patch, MAGIC.size)
        if (newSize <= 0 || newSize > MAX_NEW_SIZE) throw IOException("新包大小异常：$newSize")

        val out = ByteArray(newSize.toInt())
        var outPos = 0

        val body = ByteArrayInputStream(patch, HEADER_SIZE, patch.size - HEADER_SIZE)
        InflaterInputStream(body).use { input ->
            while (true) {
                when (val op = input.read()) {
                    -1, OP_END -> break

                    OP_COPY -> {
                        val srcOffset = readIntLE(input)
                        val length = readIntLE(input)
                        if (srcOffset < 0 || length < 0 || srcOffset + length > old.size || outPos + length > out.size) {
                            throw IOException("增量包的 COPY 越界")
                        }
                        System.arraycopy(old, srcOffset, out, outPos, length)
                        outPos += length
                    }

                    OP_ADD -> {
                        val length = readIntLE(input)
                        if (length < 0 || outPos + length > out.size) throw IOException("增量包的 ADD 越界")
                        readFully(input, out, outPos, length)
                        outPos += length
                    }

                    else -> throw IOException("增量包含未知指令：$op")
                }
            }
        }

        if (outPos != out.size) throw IOException("增量包长度不符（期望 ${out.size}，实得 $outPos）")
        return out
    }

    private fun readLongLE(bytes: ByteArray, offset: Int): Long {
        var value = 0L
        for (i in 0 until 8) {
            value = value or ((bytes[offset + i].toLong() and 0xff) shl (8 * i))
        }
        return value
    }

    private fun readIntLE(input: InputStream): Int {
        val b0 = input.read()
        val b1 = input.read()
        val b2 = input.read()
        val b3 = input.read()
        if (b3 < 0) throw IOException("增量包被截断")
        return (b0 and 0xff) or ((b1 and 0xff) shl 8) or ((b2 and 0xff) shl 16) or ((b3 and 0xff) shl 24)
    }

    private fun readFully(input: InputStream, target: ByteArray, offset: Int, length: Int) {
        var read = 0
        while (read < length) {
            val n = input.read(target, offset + read, length - read)
            if (n < 0) throw IOException("增量包被截断")
            read += n
        }
    }
}
