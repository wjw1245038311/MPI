package com.mpi.app.data

import com.mpi.app.protocol.RemoteModels
import com.mpi.app.protocol.RemoteProject
import com.mpi.app.protocol.RemoteThreadState
import com.mpi.app.protocol.RemoteThreadSummary
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 首页需要的数据快照（对齐 PWA 的 SessionSnapshot）。
 */
data class HostSnapshot(
    /** 已连上主机（加密通道就绪）。 */
    val online: Boolean = false,
    val projects: List<RemoteProject> = emptyList(),
    val threadsByProject: Map<String, List<RemoteThreadSummary>> = emptyMap(),
    val loading: Boolean = false,
    /** 整体加载失败的原因（可操作文案）。 */
    val error: String? = null,
    /**
     * 局部失败（某个项目的会话列表取不到）。不整体失败但要让人知道——
     * 「列表少了一块」这种静默降级最容易让人以为数据本来就是空的。
     */
    val partialErrors: List<String> = emptyList(),
    /**
     * 当前列表来自本地缓存（本次连接还没刷新成功），值是缓存写入时间。
     * 刷新成功即置回 null——UI 据此在离线时提示「显示的是本地缓存」。
     */
    val cachedAt: Long? = null,
) {
    /** 所有项目下的会话，按更新时间倒序——列表 UI 直接用。 */
    val allThreads: List<RemoteThreadSummary>
        get() = threadsByProject.values.flatten().sortedByDescending { it.updatedAt }

    val hasRunning: Boolean
        get() = threadsByProject.values.any { list -> list.any { it.state == RemoteThreadState.Running } }
}

/**
 * 主机数据仓库（M1-4）：拉 `projects.list` + 每个项目的 `threads.list`，
 * 暴露 [snapshot]；有会话在跑时按 [pollIntervalMs] 轮询。
 *
 * 只依赖一个 `request` 函数而不是 [Requester] 实体，便于单元测试（无需中继）。
 */
class HostRepository(
    private val scope: CoroutineScope,
    private val request: suspend (type: String, payload: JsonElement?) -> JsonElement?,
    private val sessionState: StateFlow<SessionState>,
    private val pollIntervalMs: Long = DEFAULT_POLL_MS,
    /** 本地缓存（本地缓存 A 方案）；为 null 则退化为纯在线模式。 */
    private val hostId: String? = null,
    private val cache: HomeCache? = null,
) {
    private val _snapshot = MutableStateFlow(HostSnapshot())
    val snapshot: StateFlow<HostSnapshot> = _snapshot.asStateFlow()

    init {
        // 用当前会话状态初始化「在线」：否则没调 start() 时快照会一直是离线的，
        // 轮询也就不会启动（很容易写成“忘了调 start”的静默故障）。
        _snapshot.update { it.copy(online = sessionState.value is SessionState.Connected) }
        // 先用磁盘上的上一次列表兜底：应用重启 + 断网时首屏不空白
        if (hostId != null && cache != null) {
            cache.load(hostId)?.let { cached ->
                _snapshot.update { cached.snapshot.copy(online = it.online) }
            }
        }
    }

    private val refreshLock = Mutex()
    private var pollJob: Job? = null
    private var watchJob: Job? = null
    private var lastCacheWriteAt = 0L

    /**
     * 刷新进行中又被点了一次（用户手动「刷新」/ 重试）。
     *
     * 旧实现是 `tryLock` 失败就**静默 return**：用户点刷新时刚好有轮询在跑 → 界面一点反应
     * 都没有，看起来像「刷新按钮坏了」（真机反馈 2026-11-05）。现在改成合并：记下来，
     * 现任这一轮跑完再补跑一次。
     */
    @Volatile
    private var refreshAgain = false

    /** 跟随会话状态：连上就自动刷新；掉线就停轮询并标离线。 */
    fun start() {
        watchJob?.cancel()
        watchJob = scope.launch {
            sessionState.collect { state ->
                val online = state is SessionState.Connected
                _snapshot.update { it.copy(online = online) }
                if (online) {
                    refresh()
                } else {
                    pollJob?.cancel()
                    pollJob = null
                }
            }
        }
    }

    /**
     * 拉一次列表。
     *
     * @param userInitiated 用户**主动**点了「刷新」/「重试」。
     *   这时如果已经有一轮在跑，不能静默丢掉（旧行为：`tryLock` 失败就 return，
     *   真机观感就是「刷新没反应」）——记一个标记，等这一轮跑完再补跑一次 [refreshAgain]。
     *   轮询 / 连接恢复这类自动调用保持「合并即忽略」，不把主机打成请求风暴。
     */
    suspend fun refresh(userInitiated: Boolean = false) {
        if (!refreshLock.tryLock()) {
            if (userInitiated) refreshAgain = true
            return
        }
        try {
            do {
                refreshAgain = false
                doRefresh()
            } while (refreshAgain)
        } finally {
            refreshLock.unlock()
            schedulePoll()
        }
    }

    fun stop() {
        watchJob?.cancel()
        pollJob?.cancel()
        pollJob = null
        watchJob = null
    }

    private suspend fun doRefresh() {
        _snapshot.update { it.copy(loading = true, error = null) }

        val projects = try {
            RemoteModels.decodeProjects(request("projects.list", null))
        } catch (e: kotlinx.coroutines.CancellationException) {
            // 被取消（切设备 / 退后台）：必须把 loading 收掉，否则首屏永远转圈
            _snapshot.update { it.copy(loading = false) }
            throw e
        } catch (e: Exception) {
            _snapshot.update { it.copy(loading = false, error = e.message ?: "加载项目列表失败") }
            return
        }

        val partial = mutableListOf<String>()
        val threads = try {
            coroutineScope {
                projects.map { project ->
                    async {
                        val threadsForProject = try {
                            RemoteModels.decodeThreads(
                                request("threads.list", buildJsonObject { put("projectId", project.id) }),
                            )
                        } catch (e: Exception) {
                            // 单个项目失败不拖垮整列，但记下来给 UI 提示
                            synchronized(partial) {
                                partial += "${project.name.ifEmpty { project.id }}：${e.message ?: "加载失败"}"
                            }
                            emptyList()
                        }
                        project.id to threadsForProject
                    }
                }.awaitAll().toMap()
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            // 同上：取消也要收 loading，否则首屏卡在加载态
            _snapshot.update { it.copy(loading = false) }
            throw e
        }

        _snapshot.update {
            it.copy(
                projects = projects,
                threadsByProject = threads,
                loading = false,
                error = null,
                partialErrors = partial.toList(),
                // 真实列表拿到了，不再处于「显示缓存」状态
                cachedAt = null,
            )
        }
        // 顺手写缓存：下次重启先用它渲染（断网也能看列表）。
        // 轮询时 refresh 每几秒跑一次，这里节流，避免不停写磁盘。
        if (hostId != null && cache != null) {
            val now = System.currentTimeMillis()
            if (now - lastCacheWriteAt >= CACHE_WRITE_MIN_INTERVAL_MS) {
                lastCacheWriteAt = now
                cache.save(hostId, _snapshot.value)
            }
        }
    }

    /** 只有在「已连上」且「有会话在跑」时才继续轮询——空闲时不该有请求。 */
    private fun schedulePoll() {
        pollJob?.cancel()
        pollJob = null
        val snapshot = _snapshot.value
        if (!snapshot.online || !snapshot.hasRunning) return
        pollJob = scope.launch {
            delay(pollIntervalMs)
            refresh()
        }
    }

    companion object {
        const val DEFAULT_POLL_MS = 5_000L

        /** 首页缓存写入的最小间隔（轮询期间不要每 5 秒写一次盘）。 */
        const val CACHE_WRITE_MIN_INTERVAL_MS = 60_000L
    }
}
