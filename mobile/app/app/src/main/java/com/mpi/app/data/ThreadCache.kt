package com.mpi.app.data

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

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

    /**
     * 把**增量快照**合并进缓存。
     *
     * 为什么需要：打开会话时为了秒开先 prime 了缓存，之后 subscribe 必然带上
     * `haveMessageId` → 主机只回「锚点及其之后」。若照旧不写缓存，缓存就永远停在
     * 最开始那份全量上 —— 表现为「刷新后名字/状态都对了，杀掉 App 重开又变回旧的」
     * （2026-09-26 真机：模型名刷新后正确、重开又成裸 id）。
     *
     * 合并规则：旧缓存的 messages 里**锚点之前**的部分保留，锚点及其之后一律用新到的
     * （新快照的其它字段本来就是最新的，直接覆盖）。锚点找不到 = 主机实际回了全量，
     * 直接用新的。
     */
    fun mergeIncremental(hostId: String, threadId: String, payload: JsonElement) {
        val incoming = payload as? JsonObject ?: return
        val old = read(hostId, threadId)?.payload as? JsonObject
        write(hostId, threadId, mergeIncrementalPayload(old, incoming))
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

/**
 * 见 [ThreadCache.mergeIncremental]；抽成纯函数便于单测。
 *
 * 输入是两份主机响应 JSON（旧缓存 + 新到的增量，形如 `{"snapshot":{...}}`），
 * 输出可直接落盘的那份。
 */
internal fun mergeIncrementalPayload(old: JsonObject?, incoming: JsonObject): JsonObject {
    val incomingSnapshot = incoming["snapshot"] as? JsonObject ?: return incoming
    val incomingMessages = incomingSnapshot["messages"] as? JsonArray ?: return incoming
    if (incomingMessages.isEmpty()) return incoming
    val oldMessages = (old?.get("snapshot") as? JsonObject)?.get("messages") as? JsonArray ?: return incoming
    val anchorId = (incomingMessages.first() as? JsonObject)?.stringOrNull("id") ?: return incoming
    val anchorIndex = oldMessages.indexOfFirst { (it as? JsonObject)?.stringOrNull("id") == anchorId }
    // 锚点找不到（-1）→ 主机实际回的是全量；锚点就在开头（0）→ 无需保留旧的头部。
    if (anchorIndex <= 0) return incoming
    val head = oldMessages.take(anchorIndex)
    val mergedMessages = JsonArray(head + incomingMessages)
    return JsonObject(
        incoming.toMutableMap().apply {
            put(
                "snapshot",
                JsonObject(incomingSnapshot.toMutableMap().apply { put("messages", mergedMessages) }),
            )
        },
    )
}

private fun JsonObject.stringOrNull(key: String): String? =
    runCatching { get(key)?.jsonPrimitive?.content }.getOrNull()
