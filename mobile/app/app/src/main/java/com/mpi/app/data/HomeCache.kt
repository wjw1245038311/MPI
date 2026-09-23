package com.mpi.app.data

import com.mpi.app.protocol.RemotePermission
import com.mpi.app.protocol.RemoteProject
import com.mpi.app.protocol.RemoteThreadState
import com.mpi.app.protocol.RemoteThreadSummary
import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** 一页缓存下来的首页数据。 */
data class CachedHome(val snapshot: HostSnapshot, val savedAt: Long)

@Serializable
internal data class HomeProjectDto(
    val id: String,
    val name: String = "",
    val threadCount: Int = 0,
    val updatedAt: Long = 0,
)

@Serializable
internal data class HomeThreadDto(
    val id: String,
    val projectId: String = "",
    val title: String = "",
    val preview: String = "",
    val updatedAt: Long = 0,
    val messageCount: Int = 0,
    val state: String = "",
    val permission: String = "",
    val pinned: Boolean = false,
)

@Serializable
internal data class HomeSnapshotDto(
    val savedAt: Long = 0,
    val projects: List<HomeProjectDto> = emptyList(),
    val threads: Map<String, List<HomeThreadDto>> = emptyMap(),
)

/**
 * 首页列表本地缓存（本地缓存 A 方案）：把 `projects.list` + `threads.list`
 * 的结果按主机落盘，应用重启后**断网也能看到上次的会话列表**。
 *
 * 只缓存「列表」，不缓存「在线状态 / 错误」——那些必须由本次会话的真实连接决定，
 * 从磁盘上恢复一个假的 online 只会让人以为连上了。加载出来的快照 online 固定为
 * false，由 [HostRepository] 用当前会话状态覆盖。
 *
 * 损坏 / 写失败一律静默当没有（同 [ThreadCache]）：缓存是加速手段，不是数据源。
 */
class HomeCache(private val root: File) {
    private val json = Json { ignoreUnknownKeys = true }

    fun load(hostId: String): CachedHome? {
        val file = fileFor(hostId)
        if (!file.isFile) return null
        return try {
            val dto = json.decodeFromString(HomeSnapshotDto.serializer(), file.readText())
            val snapshot = HostSnapshot(
                online = false,
                projects = dto.projects.map {
                    RemoteProject(id = it.id, name = it.name, threadCount = it.threadCount, updatedAt = it.updatedAt)
                },
                threadsByProject = dto.threads.mapValues { (_, list) -> list.map { it.toDomain() } },
                cachedAt = dto.savedAt,
            )
            CachedHome(snapshot, dto.savedAt)
        } catch (_: Exception) {
            runCatching { file.delete() }
            null
        }
    }

    fun save(hostId: String, snapshot: HostSnapshot) {
        runCatching {
            val dto = HomeSnapshotDto(
                savedAt = System.currentTimeMillis(),
                projects = snapshot.projects.map {
                    HomeProjectDto(it.id, it.name, it.threadCount, it.updatedAt)
                },
                threads = snapshot.threadsByProject.mapValues { (_, list) ->
                    list.map { thread ->
                        HomeThreadDto(
                            id = thread.id,
                            projectId = thread.projectId,
                            title = thread.title,
                            preview = thread.preview,
                            updatedAt = thread.updatedAt,
                            messageCount = thread.messageCount,
                            state = thread.state.name.lowercase(),
                            permission = if (thread.permission == RemotePermission.Full) "full" else "sandbox",
                            pinned = thread.pinned,
                        )
                    }
                },
            )
            val bytes = json.encodeToString(HomeSnapshotDto.serializer(), dto).toByteArray()
            CacheFiles.atomicWrite(fileFor(hostId), bytes)
        }
    }

    fun deleteHost(hostId: String) {
        runCatching { fileFor(hostId).delete() }
    }

    fun clear() {
        runCatching { root.deleteRecursively() }
    }

    private fun fileFor(hostId: String): File = File(root, CacheFiles.hash(hostId) + ".json")

    private fun HomeThreadDto.toDomain(): RemoteThreadSummary = RemoteThreadSummary(
        id = id,
        projectId = projectId,
        title = title,
        preview = preview,
        updatedAt = updatedAt,
        messageCount = messageCount,
        state = RemoteThreadState.fromWire(state),
        permission = RemotePermission.fromWire(permission),
        pinned = pinned,
    )

    companion object {
        /** 应用私有目录下的缓存根目录名。 */
        const val DIR_NAME = "home-cache"
    }
}
