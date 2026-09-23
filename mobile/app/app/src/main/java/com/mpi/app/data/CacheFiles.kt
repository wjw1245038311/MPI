package com.mpi.app.data

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/**
 * 本地缓存公共工具（会话缓存 / 首页缓存共用）。
 *
 * 缓存目录以 **hash 后的主机/会话 id** 命名：id 里可能带 `:`、`/` 之类的字符，
 * 直接当文件名在某些文件系统上会失败；hash 同时也让目录名不泄露 id 原文。
 */
internal object CacheFiles {

    /** SHA-256 十六进制（小写）。 */
    fun hash(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }

    /** 先写临时文件再原子替换：写一半被打断也不会毁掉旧缓存。 */
    fun atomicWrite(file: File, bytes: ByteArray) {
        file.parentFile?.mkdirs()
        val temp = File(file.parentFile, "${file.name}.tmp")
        temp.writeBytes(bytes)
        try {
            Files.move(
                temp.toPath(),
                file.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
        } catch (_: Exception) {
            // 某些文件系统不支持原子移动，退化为普通替换
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
