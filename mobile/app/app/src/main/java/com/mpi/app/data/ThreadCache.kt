package com.mpi.app.data

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** 一条本地缓存的会话快照。 */
data class CachedThread(val payload: JsonElement, val savedAt: Long)

/**
 * 会话快照本地缓存（本地缓存 A 方案）：把每次 `thread.subscribe`/`thread.resync`
 * 拿到的**原始快照 JSON** 按主机 + 会话落盘。
 *
 * 为什么缓存「原始快照」而不是解析后的消息：快照的线格式已经由
 * [com.mpi.app.protocol.ThreadModels] 严格解析过（能解析才写进来），
 * 存原文省掉一层 DTO 往返，升级协议时旧缓存最多是解析失败被丢弃，
 * 不会把错误数据喂给归约器。
 *
 * 设计取舍：
 * - **写失败绝不打扰用户**：缓存是加速手段，不是数据源；磁盘满 / 权限异常都当没有缓存。
 * - **读失败即删**：损坏的缓存留着只会每次启动都重试解析，删掉等下一次刷新重建。
 * - **有上限**：单个快照超 [maxBytesPerEntry] 不缓存（通常是一屏塞满 base64 图片）；
 *   每个主机最多留 [maxEntries] 条、总量超 [maxBytesTotal] 时从最旧的开始删。
 * - 明文存放于应用私有目录（`filesDir/thread-cache/`，root 之外读不到）；
 *   配对凭证仍走 Keystore 加密卷，两者不混。
 */
class ThreadCache(
    private val root: File,
    private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
    private val maxBytesPerEntry: Long = DEFAULT_MAX_BYTES_PER_ENTRY,
    private val maxBytesTotal: Long = DEFAULT_MAX_BYTES_TOTAL,
) {
    private val json = Json { ignoreUnknownKeys = true }

    /** 读取缓存；不存在或损坏（自动删除）都返回 null。 */
    fun read(hostId: String, threadId: String): CachedThread? {
        val file = fileFor(hostId, threadId)
        if (!file.isFile) return null
        return try {
            val element = json.parseToJsonElement(file.readText())
            if (element !is JsonObject) {
                file.delete()
                null
            } else {
                CachedThread(element, file.lastModified())
            }
        } catch (_: Exception) {
            // 缓存坏了不值得打扰用户：删掉，网络刷新会补回来
            runCatching { file.delete() }
            null
        }
    }

    /** 写入缓存（原子替换 + 修剪）。任何失败都静默——缓存不该影响正常使用。 */
    fun write(hostId: String, threadId: String, payload: JsonElement) {
        runCatching {
            val text = payload.toString()
            val bytes = text.toByteArray()
            if (bytes.size > maxBytesPerEntry) return
            val dir = dirFor(hostId)
            dir.mkdirs()
            CacheFiles.atomicWrite(fileFor(hostId, threadId), bytes)
            prune(dir)
        }
    }

    /** 主机被移除时清掉它的缓存（下次重新配对不会看到旧内容）。 */
    fun deleteHost(hostId: String) {
        runCatching { dirFor(hostId).deleteRecursively() }
    }

    /** 显式重置本地数据时调用。 */
    fun clear() {
        runCatching { root.deleteRecursively() }
    }

    /** 按「条数上限 + 总量上限」修剪：保留最近写入的，从最旧的开始删。 */
    private fun prune(dir: File) {
        val files = dir.listFiles { file -> file.isFile && file.name.endsWith(EXTENSION) } ?: return
        val newestFirst = files.sortedByDescending { it.lastModified() }
        var total = 0L
        newestFirst.forEachIndexed { index, file ->
            total += file.length()
            if (index >= maxEntries || total > maxBytesTotal) {
                runCatching { file.delete() }
            }
        }
    }

    private fun fileFor(hostId: String, threadId: String): File =
        File(dirFor(hostId), CacheFiles.hash(threadId) + EXTENSION)

    private fun dirFor(hostId: String): File = File(root, CacheFiles.hash(hostId).take(16))

    companion object {
        /** 应用私有目录下的缓存根目录名。 */
        const val DIR_NAME = "thread-cache"

        const val EXTENSION = ".json"

        const val DEFAULT_MAX_ENTRIES = 20

        /** 单条快照上限（约 4 MB，正常几百条消息远不到）。 */
        const val DEFAULT_MAX_BYTES_PER_ENTRY = 4L * 1024 * 1024

        /** 每个主机的缓存总量上限。 */
        const val DEFAULT_MAX_BYTES_TOTAL = 32L * 1024 * 1024
    }
}
