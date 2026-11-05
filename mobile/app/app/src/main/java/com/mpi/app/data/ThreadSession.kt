package com.mpi.app.data

import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.ContextUsage
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.ModelOption
import com.mpi.app.protocol.ModelRef
import com.mpi.app.protocol.RemotePermission
import com.mpi.app.protocol.RemoteThreadState
import com.mpi.app.protocol.RemoteThreadSummary
import com.mpi.app.protocol.TaskModeOption
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.protocol.ThreadModels
import com.mpi.app.protocol.UiRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 会话视图状态（对照 PWA 的 `ThreadView`）。
 *
 * 历史渲染来自快照，流式部分来自事件归约（与 PWA 的简化归约器同构）。
 */
data class ThreadView(
    val threadId: String,
    /** 快照至少应用过一次，UI 可渲染。 */
    val ready: Boolean = false,
    val summary: RemoteThreadSummary? = null,
    val messages: List<ThreadMessage> = emptyList(),
    /** 进行中的助手消息（流式）。 */
    val streaming: ThreadMessage? = null,
    /** 回合进行中（agent_start … agent_settled）。 */
    val running: Boolean = false,
    val errorBanner: String? = null,
    val model: ModelRef? = null,
    val availableModels: List<ModelOption> = emptyList(),
    /** 当前思考档位（off / minimal / …；null = 主机未上报）。 */
    val thinkingLevel: String? = null,
    /** 当前模型可选的思考档位（主机上报；空 = 客户端自行推断）。 */
    val availableThinkingLevels: List<String> = emptyList(),
    val taskMode: String? = null,
    val availableModes: List<TaskModeOption> = emptyList(),
    val contextUsage: ContextUsage? = null,
    val compacting: Boolean = false,
    /**
     * 交接进度（主机在 `thread.handoff` 过程中推的 `handoff_progress`）。
     * 一次交接要十几秒到一分钟（生成文档是整轮模型），没有它只能「干等」。
     * null = 没有进行中的交接。
     */
    val handoff: HandoffProgress? = null,
    /** 待处理的审批/询问卡；**重连后仍要显示**（主机在等回应，弹窗没关）。 */
    val pendingUi: UiRequest? = null,
    /**
     * 当前内容来自本地缓存（尚未拿到实时快照），值是缓存的写入时间。
     * 实时快照到达后置回 null；离线时一直有值，UI 据此提示「离线：显示本地缓存」。
     */
    val cachedAt: Long? = null,
) {
    /** 列表要渲染的全部消息（历史 + 流式中）。 */
    val renderable: List<ThreadMessage>
        get() = if (streaming != null) messages + streaming else messages

    /** 正在展示本地缓存（未与主机同步）。 */
    val showingCached: Boolean
        get() = cachedAt != null
}

/**
 * 主机推的交接进度（对应 PWA 的 `HandoffProgress`）。
 *
 * phase：doc（生成交接文档，最慢）→ create（新建会话）→ config（继承配置）→ prompt（发首条
 * 提示词）→ done；出错时发 error（带到 message）。
 */
data class HandoffProgress(
    val phase: String,
    /** 主机开始交接的时刻（毫秒）：秒表按它算，不受本地请求起始时间影响。 */
    val startedAt: Long,
    /** 主机侧的阶段耗时（毫秒）。 */
    val elapsedMs: Long = 0,
    /** 新会话 id（create 之后才有）。 */
    val threadId: String? = null,
    /** 交接文档路径（create 之后才有）。 */
    val docPath: String? = null,
    /** phase=error 时的原因。 */
    val message: String? = null,
)

/**
 * 单会话数据层（M2-1）：订阅快照 → 归约 `thread.event` 事件流 → 供 UI 渲染。
 *
 * 三条关键行为（都来自 PWA 踩过的坑）：
 *
 * 1. **快照到达前的事件要缓冲**：主机是先注册监听、再取快照，所以这些事件
 *    既不丢也不乱序；直接丢弃会缺一段流。
 * 2. **seq 缺口 → 立即 resync**，重复/过期事件（seq < 期望值）忽略。
 *    缺一段还接着渲染会让人看到错乱的内容。
 * 3. **快照是权威历史**：应用快照时丢掉残留的乐观占位（主机此时必然已有该消息）。
 *
 * 另外按 §1.5 的预算做了**增量节流**：文本/思考增量先入缓冲区、约每 60ms 合并
 * 提交一次，而不是每个 token 更新一次状态。遇到非增量事件会先冲刷缓冲，保证顺序。
 */
class ThreadSession(
    val threadId: String,
    private val transport: RequestTransport,
    private val request: suspend (type: String, payload: JsonElement?, threadId: String?, timeoutMs: Long?) -> JsonElement?,
    private val scope: CoroutineScope,
    /** 非致命问题上报（丢帧导致的缺口、解密失败等）。 */
    private val onProblem: (String) -> Unit = {},
    /**
     * 拿到**实时**快照时的回调（用于写本地缓存）。
     * 缓存写入失败不该影响会话本身，所以调用方自行吞异常。
     */
    private val onSnapshot: (JsonElement, Boolean) -> Unit = { _, _ -> },
) {
    private val _view = MutableStateFlow(ThreadView(threadId = threadId))
    val view: StateFlow<ThreadView> = _view.asStateFlow()

    private val lock = Any()
    private val pendingEvents = mutableListOf<Pair<Int, JsonObject>>()
    private val deltaBuffer = mutableListOf<Pair<BlockType, String>>()
    private var flushJob: Job? = null
    private var expectNext: Int? = null

    /**
     * 本地已处理到的最后一条事件序号（null = 没有可信基线）。
     *
     * 带在 `thread.subscribe` / `thread.resync` 的 `sinceSeq` 里：主机能把断线期间
     * 的事件按序补发回来，就**不用回 1.6MB 的全量快照**，也不用把正在流式的内容换掉。
     */
    private var lastSeq: Int? = null

    /**
     * 正在等 subscribe / resync 的**响应**：这段时间收到的帧先缓冲，响应落地后按序重放。
     *
     * ⚠️ 不能用 `ready` 代替：缓存预热会把 ready 置 true，但那时订阅响应还没到；
     * 而且快照帧大、解析慢，小的事件帧会先到——不缓冲就会被当成「缺号」触发下一次
     * resync，快照又大又慢，于是形成自激循环（2026-10-28 真机：5 秒内 5 次重同步，
     * 每次 1.6MB，手机上就是「一直停在旧内容」）。PWA 早就有这层缓冲，安卓缺。
     */
    @Volatile
    private var awaitingSync = false

    /** 本轮同步的开始时刻（毫秒）——用于 [SYNC_STALL_MS] 卡住取证。 */
    @Volatile
    private var awaitingSince = 0L
    /** 本轮同步已经上报过「卡住」，不重复刷屏。 */
    @Volatile
    private var stallReported = false

    /** 进入等同步态（记时刻 + 清掉上一轮的「已上报」标记）。 */
    private fun beginSync() {
        awaitingSync = true
        awaitingSince = System.currentTimeMillis()
        stallReported = false
    }

    /** 进行中的重同步（缺口可能连着来好几条帧，只跑一次）。 */
    private var resyncJob: Job? = null

    private val respondedUiIds = mutableSetOf<String>()
    private var closing = false

    /**
     * 订阅/同步互斥：重连自愈、发送兜底、seq 缺口补齐都可能并发触发，
     * 串行化避免两次 `applySnapshot` 交错写 view（也会重复拉全量快照）。
     */
    private val syncLock = Mutex()

    /**
     * 「带图用户消息」全量补拉防抖：事件通道不带图片本体（主机只留 omitted 标记），
     * 别人发的图必须靠一次全量快照补齐；短时间多条只拉一次。
     */
    @Volatile
    private var mediaBackfillPending = false

    /**
     * 当前连接上是否已注册订阅。
     *
     * 主机按 **connectionId** 记订阅，`transportClosed` 时会把它清掉——
     * 所以重连（新连接）之后必须重新注册，否则实时事件会被主机静默丢弃。
     */
    @Volatile
    private var subscribed = false

    private val unsubscribe = transport.onEnvelope { envelope -> handleEnvelope(envelope) }

    /**
     * 用本地缓存预热（本地缓存 A 方案）：先渲染缓存内容实现"秒开"，
     * 随后 [subscribe] 用实时快照替换。缓存解析失败就静默忽略，等价于没有缓存。
     */
    fun prime(payload: JsonElement, savedAt: Long) {
        val snapshot = try {
            ThreadModels.decodeSnapshot(payload)
        } catch (_: Exception) {
            return
        }
        synchronized(lock) {
            _view.value = _view.value.copy(
                ready = true,
                summary = snapshot.summary,
                messages = snapshot.messages,
                streaming = null,
                running = snapshot.summary.state == RemoteThreadState.Running,
                model = snapshot.model,
                availableModels = snapshot.availableModels,
                thinkingLevel = snapshot.thinkingLevel.ifEmpty { null },
                availableThinkingLevels = snapshot.thinkingLevels,
                taskMode = snapshot.taskMode,
                availableModes = snapshot.availableModes,
                contextUsage = snapshot.contextUsage,
                cachedAt = savedAt,
            )
            // 缓存里的 seq 基线已经过时，实时事件到达时重新建立期望值
            expectNext = null
            lastSeq = null
        }
    }

    /** 订阅并取快照。重复调用是安全的（用于重连后重新同步）。 */
    suspend fun subscribe() {
        syncLock.withLock {
            beginSync()
            val payload = try {
                requestWhenReady("thread.subscribe", threadIdPayload(), threadId, SNAPSHOT_TIMEOUT_MS)
            } catch (e: Exception) {
                finishSync()
                _view.value = _view.value.copy(ready = true, errorBanner = friendlyError(e))
                throw e
            }
            subscribed = true
            applySyncResponse(payload)
        }
    }

    /**
     * 等认证就绪再发请求（只对 `NotReady`——「连接未就绪」——重试，约 15s）。
     *
     * 为什么需要：App 一起来就自动开会话（还先铺本地缓存），而此刻 E2E 认证可能还没跑完
     * ——请求会立刻以 NotReady 失败。真机现象：启动后那条「无法发送 thread.subscribe 请求
     * （连接未就绪）」横幅一直挂着，得手动「重新同步」或重启 App 才恢复（2026-09-26 反馈）。
     * 这里有限重试，认证一完成就自动接上；真的超时了才把错误冒给上层。
     */
    private suspend fun requestWhenReady(
        type: String,
        payload: JsonElement,
        threadId: String,
        timeoutMs: Long? = null,
    ): JsonElement? {
        var attempt = 0
        while (true) {
            try {
                return request(type, payload, threadId, timeoutMs)
            } catch (e: RequestException) {
                if (e.kind != RequestException.Kind.NotReady || attempt >= READY_RETRY_LIMIT) throw e
                attempt++
                delay(READY_RETRY_INTERVAL_MS)
            }
        }
    }

    /**
     * 重连后调用：新连接在主机侧没有订阅（旧连接断开时已被清掉），标记失效，
     * 让下一次 [resync] / [ensureSubscribed] 重新注册。
     */
    fun invalidateSubscription() {
        subscribed = false
    }

    /**
     * 本地先行更新当前模型（远程切模型成功后立刻反馈，不等主机 config_changed 事件往返）。
     *
     * 主机现在也会广播 config_changed(model)，那才是权威值；这里只是把「响应 → 广播 →
     * 中继」这两跳之前的窗口填上，事件到达后是同值覆盖（幂等）。与 PWA
     * 「无 model_changed 事件，所以本地先更新徽标」同一取舍（2026-09-25 手机同步排查）。
     */
    fun noteLocalModel(provider: String, id: String) {
        patch { it.copy(model = ModelRef(provider, id)) }
    }

    /**
     * 确保当前连接上已注册订阅（幂等）。
     *
     * 真机踩过：主机按 connectionId 记订阅，重连后旧订阅被清掉，而 [resync] 只拉
     * 快照不注册——只 resync 的话之后所有实时事件都被主机静默丢弃（diag 里能看到
     * `remote-pub … subs=0`），表现为「气泡卡发送中 / 整条消息包括回复一起晚到」。
     *
     * @return 本次**刚补上**订阅时返回它携带的快照（调用方可直接应用，省一次往返）；
     *   已订阅时返回 null（不发请求）。
     */
    private suspend fun ensureSubscribedLocked(full: Boolean = false): JsonElement? {
        if (subscribed) return null
        beginSync()
        val payload = requestWhenReady("thread.subscribe", threadIdPayload(full), threadId, SNAPSHOT_TIMEOUT_MS)
        subscribed = true
        return payload
    }

    /**
     * 发送路径的兜底：正在对话时保证订阅在（已订阅时零开销）。
     * 失败只经 [onProblem] 上报，**不阻断发送**——订阅丢不该让用户发不出消息。
     */
    suspend fun ensureSubscribed() {
        syncLock.withLock {
            try {
                beginSync()
                ensureSubscribedLocked()?.let { applySyncResponse(it) } ?: finishSync()
            } catch (e: Exception) {
                finishSync()
                onProblem("订阅恢复失败：${e.message ?: "未知错误"}")
            }
        }
    }

    /**
     * 重新同步（seq 缺口或重连后）。
     *
     * **未订阅时直接走订阅**：它带回的快照就是最新的，既不漏注册又省一次往返
     * （重连自愈的关键路径）。已订阅时才走 `thread.resync`，保住 live 快照语义。
     */
    /**
     * @param full 强制全量快照（不带 haveMessageId）：用于补拉事件通道里被省略的图片块。
     */
    suspend fun resync(full: Boolean = false) {
        syncLock.withLock {
            try {
                beginSync()
                val fresh = ensureSubscribedLocked(full)
                if (fresh != null) {
                    applySyncResponse(fresh)
                    return@withLock
                }
                val payload = requestWhenReady("thread.resync", threadIdPayload(full), threadId, SNAPSHOT_TIMEOUT_MS)
                applySyncResponse(payload)
            } catch (e: Exception) {
                finishSync()
                _view.value = _view.value.copy(errorBanner = e.message ?: "同步失败")
                // 同步失败必须进问题列表：只挂 errorBanner 时用户很容易看不到
                //（2026-11-05：「刷新没反应」现场就是这个状况——失败被吞在局部）。
                onProblem("同步失败：${e.message ?: "未知错误"}")
                throw e
            }
        }
    }

    /**
     * 重命名成功（主机已提交）后就地更新摘要标题。
     *
     * 不走 [resync]：回合进行中 resync 会用快照替换 messages/streaming，顶栏闪一下
     * 还可能打断流式渲染；标题是主机已确认的事实，直接 patch 即可。
     */
    fun applyRenamedTitle(name: String) {
        patch { view ->
            val summary = view.summary ?: return@patch view
            view.copy(summary = summary.copy(title = name))
        }
    }

    /**
     * 乐观回显：点发送后立刻上屏，不等主机回执（§1.1「点击到视觉反馈 < 100ms」）。
     * 主机回执到达时由 [applyEvent] 的 message_start 把这条「转正」，避免重复上屏。
     *
     * @param imageBlocks 本地已压好的图片块。**必须由客户端自己上屏**：图片的 base64
     *   太大，主机在事件通道会把它截断（remoteSafeString 100k），直接渲染会变成坏数据；
     *   而快照（remoteMessages，400k 预算）不受影响——所以自己发的图先用本地字节显示，
     *   下次快照时换成主机那份。
     */
    fun echoUserMessage(text: String, imageBlocks: List<MessageBlock> = emptyList()): String {
        val id = "u-local-${System.nanoTime()}"
        val blocks = buildList {
            if (text.isNotEmpty()) add(MessageBlock(type = BlockType.Text, text = text))
            addAll(imageBlocks)
        }
        synchronized(lock) {
            _view.value = _view.value.copy(
                messages = _view.value.messages + ThreadMessage(
                    id = id,
                    role = "user",
                    pending = true,
                    blocks = blocks,
                ),
            )
        }
        return id
    }

    /** 把某条乐观消息标记为失败（发送失败时保留在原位并给重试，见 §1.1）。 */
    fun markSendFailed(localId: String, reason: String) {        synchronized(lock) {
            _view.value = _view.value.copy(
                messages = _view.value.messages.map { message ->
                    if (message.id == localId) {
                        message.copy(errorMessage = reason, stopReason = "send_failed")
                    } else {
                        message
                    }
                },
            )
        }
    }

    /**
     * 为重试准备：取出失败消息的文本，并把它重置为「发送中」。
     * 返回 null 表示找不到该消息或它没有文本。
     */
    fun prepareRetry(localId: String): String? {
        synchronized(lock) {
            val message = _view.value.messages.firstOrNull { it.id == localId } ?: return null
            val text = message.blocks
                .filter { it.type == BlockType.Text }
                .mapNotNull { it.text }
                .joinToString("")
            if (text.isEmpty()) return null
            _view.value = _view.value.copy(
                messages = _view.value.messages.map {
                    if (it.id == localId) it.copy(errorMessage = null, stopReason = null, pending = true) else it
                },
            )
            return text
        }
    }

    /**
     * resync 时校对本地审批卡（与 PWA 的 resolvePendingUiAfterResync 同判据）。
     *
     * 三种输入（宿主传的是原始 JsonElement，才能区分「字段缺失」与「字段是 null」）：
     *   - 缺省 → 旧主机，原样保留（不能据此清卡）
     *   - null → 主机没有挂着的卡，本地那张已失效 → 清掉
     *   - "<id>" → 主机还挂着这张：是它就留；是**别的** id 就清掉本地那张（新卡等事件推）
     */
    private fun resolvePendingUiAfterResync(raw: kotlinx.serialization.json.JsonElement?): UiRequest? {
        val local = _view.value.pendingUi
        // 字段缺失（旧主机）与「显式 null」在这里必须分开：前者什么都不做。
        if (raw == null) return local
        if (raw is JsonNull) {
            if (local != null) synchronized(lock) { respondedUiIds += local.id }
            return null
        }
        val pendingId = raw.jsonPrimitiveOrNull()?.contentOrNull ?: return local
        if (local == null) return null // 本地没有卡：等 ui.request 事件推正文
        if (local.id == pendingId) return local
        // 主机挂着另一张：本地这张一定已失效。
        synchronized(lock) { respondedUiIds += local.id }
        return null
    }

    /** JsonElement → JsonPrimitive（不是 primitive 就给 null）。 */
    private fun kotlinx.serialization.json.JsonElement.jsonPrimitiveOrNull(): kotlinx.serialization.json.JsonPrimitive? =
        this as? kotlinx.serialization.json.JsonPrimitive

    /** ui.respond 成功后调用：去重，避免重复推送又把卡片弹回来。 */
    fun markUiResponded(requestId: String) {
        synchronized(lock) {
            respondedUiIds += requestId
            if (_view.value.pendingUi?.id == requestId) {
                _view.value = _view.value.copy(pendingUi = null)
            }
        }
    }

    fun detach() {
        closing = true
        subscribed = false
        flushJob?.cancel()
        unsubscribe()
    }

    // ---- 事件入口 ----

    private fun handleEnvelope(envelope: com.mpi.app.protocol.RemoteEnvelope) {
        if (closing) return
        if (envelope.type != "thread.event") return
        if (envelope.threadId != null && envelope.threadId != threadId) return
        val seq = envelope.seq?.toInt() ?: 0
        val payload = envelope.payload as? JsonObject ?: return

        synchronized(lock) {
            // 快照/补发响应到达之前的事件先缓冲：主机先注册监听再取快照（或补发），
            // 所以这些帧不丢不乱。等同步的**不只是** ready 之前——快照传输期间也会
            // 进来帧，不缓冲就会被当成「缺号」再触发一次 resync（自激循环）。
            if (awaitingSync || !_view.value.ready) {
                // 取证（2026-11-05）：同步等太久说明快照/补发卡住了——此时**所有实时帧都在缓冲**，
                // 界面表现为「停在旧内容 / 一直思考中 / 刷新也没反应」。上报一次，别让这种
                // 问题静默积压（用户下次截一张问题列表就能定位）。
                if (awaitingSync && !stallReported && System.currentTimeMillis() - awaitingSince > SYNC_STALL_MS) {
                    stallReported = true
                    val waited = (System.currentTimeMillis() - awaitingSince) / 1000
                    onProblem("同步卡住：等快照已 ${waited}s，期间实时消息都在缓冲")
                }
                pendingEvents += seq to payload
                return
            }
            val expected = expectNext
            if (seq > 0 && expected != null) {
                if (seq < expected) return // 重复/过期，忽略
                if (seq > expected) {
                    // 缺了一段 —— 立即重新同步，绝不带着缺口继续渲染。
                    // 同时上报：静默 resync 会把「丢帧」这类问题掩盖掉。
                    onProblem("事件流有缺口（期望 $expected，收到 $seq），已重新同步")
                    scheduleResync()
                    return
                }
            }
        }
        applyEvent(payload, seq)
    }

    /**
     * 触发一次重同步（同一时刻只跑一个）。
     *
     * 开跑之前先置 `awaitingSync`：快照传输/解析期间到达的帧会被缓冲，而不是
     * 按旧基线再判一次缺口——否则每多一条增量就多一次 resync，5 秒内能抖出 5 次。
     */
    private fun scheduleResync() {
        synchronized(lock) {
            if (resyncJob?.isActive == true) return
            beginSync()
            resyncJob = scope.launch { runCatching { resync() } }
        }
    }

    /**
     * 处理 subscribe / resync 的响应。
     *
     * 两种形状：
     *  · `{ replayed: true, snapshot: null }` —— 主机已经把断线期间的事件按序补发回来了，
     *    **不动视图**（保住正在流式的那半条，也不搬 1.6MB 的磁盘历史）；
     *  · 其余 —— 跟以前一样当快照应用。
     */
    private fun applySyncResponse(payload: JsonElement?) {
        val obj = payload as? JsonObject
        val replayed = obj?.get("replayed")?.jsonPrimitive?.booleanOrNull == true
        val snapshotElement = obj?.get("snapshot")
        if (replayed && (snapshotElement == null || snapshotElement is JsonNull)) {
            // 补发的事件已经在 await 期间进了 pendingEvents，这里只需按序落地
            subscribed = true
            flushBuffered()
            return
        }
        applySnapshot(payload)
    }

    /** 关闭「等同步」态并把缓冲帧按抵达顺序应用（不猜基线：applyEvent 会逐条推 expectNext）。 */
    private fun flushBuffered() {
        val buffered: List<Pair<Int, JsonObject>>
        synchronized(lock) {
            awaitingSync = false
            buffered = pendingEvents.toList()
            pendingEvents.clear()
        }
        for ((seq, event) in buffered) {
            // 主机补发的事件里可能已经包含过这些帧（缺口帧本身也在缓冲里）：
            // 已经落在基线之前的丢掉，否则会重复上屏一段。
            val expected = synchronized(lock) { expectNext }
            if (seq > 0 && expected != null && seq < expected) continue
            applyEvent(event, seq)
        }
    }

    /** 同步失败：退出等同步态，把已收到的帧尽量落地（下一轮重同步会再对齐）。 */
    private fun finishSync() {
        if (_view.value.ready) flushBuffered() else synchronized(lock) { awaitingSync = false }
    }

    private fun applySnapshot(payload: JsonElement?) {
        val snapshot = ThreadModels.decodeSnapshot(payload)
        synchronized(lock) {
            _view.value = _view.value.copy(
                ready = true,
                summary = snapshot.summary,
                // 全量快照是权威历史：残留的乐观占位一并丢弃；
                // 增量快照（incremental）只带新增（含锚点那条），按 id 合并，别把本地已有历史丢掉。
                messages = if (snapshot.incremental) {
                    mergeIncremental(_view.value.messages, snapshot.messages)
                } else {
                    // 全量也不能把**还没被主机确认**的乐观消息一起丢掉：followUp 排队期间
                    // 快照里还没有那条，丢掉就表现为「消息和图片一起消失」。
                    mergeFull(_view.value.messages, snapshot.messages)
                },
                // 回合进行中**留住**正在长的流式气泡：快照是磁盘历史，不含这半条；
                // 清掉的话用户看到的就是「桌面写了一大段、手机停在上一条」。
                streaming = if (snapshot.summary.state == RemoteThreadState.Running) {
                    _view.value.streaming
                } else {
                    null
                },
                running = snapshot.summary.state == RemoteThreadState.Running,
                errorBanner = null,
                model = snapshot.model,
                availableModels = snapshot.availableModels,
                thinkingLevel = snapshot.thinkingLevel.ifEmpty { null },
                availableThinkingLevels = snapshot.thinkingLevels,
                taskMode = snapshot.taskMode,
                availableModes = snapshot.availableModes,
                contextUsage = snapshot.contextUsage,
                // 快照到达即认为压缩结束：真在压缩时后面的 compaction_end 会纠正，
                // 而漏掉一个 end 会让按钮永远转圈
                compacting = false,
                // 审批卡：默认保留（断线期间不能丢卡），但要跟主机核对——
                // 手机在后台断线时会**错过** `ui.resolved`（桌面已经点了「允许」），
                // 保留旧卡就会挂着一张已经失效的卡片（2026-11-04 真机）。
                pendingUi = resolvePendingUiAfterResync(snapshot.pendingUiId),
                // 实时快照到了，不再是"显示缓存"状态
                cachedAt = null,
            )
            // 重新定位 seq 基线；第一条实时事件会重新建立期望值
            expectNext = null
            lastSeq = null
            awaitingSync = false
        }
        // 拿到的实时快照写缓存（下一次打开就能秒开）。
        // 增量也要写：打开会话时因为先 prime 了缓存，subscribe 必带 haveMessageId →
        // 主机只回增量；不写的话缓存永远停在最早那份全量，表现为「刷新后对了、
        // 重开 App 又变回旧的」（2026-09-26 真机：模型名刷新后正确、重开又成裸 id）。
        // 合并细节交给缓存层（按锚点拼接 messages）。
        payload?.let { runCatching { onSnapshot(it, snapshot.incremental) } }
        flushBuffered()
    }

    private fun applyEvent(payload: JsonObject, seq: Int) {
        val kind = payload.str("kind").orEmpty()
        val data = payload["data"] as? JsonObject
        val event = data?.get("event") as? JsonObject

        // 只有文本/思考**增量**会进缓冲区；其余事件前先冲刷，保证渲染顺序。
        // （无条件冲刷会让每个 message_update 都提交前一个增量——节流就失效了。）
        val deltaType = if (kind == "message_update") {
            (event?.get("assistantMessageEvent") as? JsonObject)?.str("type")
        } else {
            null
        }
        if (deltaType != "text_delta" && deltaType != "thinking_delta") flushDeltas()

        when (kind) {
            "agent_start" -> patch { it.copy(running = true) }

            "message_start" -> handleMessageStart(event, seq)

            "message_update" -> {
                val ame = event?.get("assistantMessageEvent") as? JsonObject
                if (ame != null) queueAssistantDelta(ame)
            }

            "tool_execution_start" -> {
                event?.str("toolCallId")?.let { id -> markTool(id, running = true, name = event.str("toolName")) }
            }

            "tool_execution_end" -> {
                val id = event?.str("toolCallId")
                if (id != null) {
                    val result = textOfContent((event["result"] as? JsonObject)?.get("content"))
                    markTool(id, running = false, text = result, isError = event.bool("isError"), name = event.str("toolName"))
                }
            }

            "message_end" -> handleMessageEnd(event)

            "agent_settled" -> settleTurn()

            "thread.error" -> {
                val message = data?.str("message") ?: "远程错误"
                settleTurn(errorBanner = message)
            }

            "thread.exit" -> {
                val code = data?.get("code")?.jsonPrimitive?.contentOrNull
                settleTurn(errorBanner = "进程已退出${code?.let { "（code $it）" } ?: ""}")
            }

            "permission_changed" -> {
                val permission = data?.str("permission")
                if (permission != null) {
                    patch { view ->
                        val summary = view.summary ?: return@patch view
                        view.copy(summary = summary.copy(permission = RemotePermission.fromWire(permission)))
                    }
                }
            }

            "context_usage" -> handleContextUsage(data)

            "compaction_start" -> patch { it.copy(compacting = true) }

            "compaction_end" -> patch { it.copy(compacting = false) }

            "handoff_progress" -> handleHandoffProgress(data)

            "config_changed" -> handleConfigChanged(data)

            "ui.request" -> {
                val request = ThreadModels.decodeUiRequest(data?.get("request"))
                if (request != null && request.id !in respondedUiIds && _view.value.pendingUi?.id != request.id) {
                    patch { it.copy(pendingUi = request) }
                }
            }

            // 别的端（桌面）已经应答了：把本机挂着的卡收起来（2026-11-04）。
            // 不处理的话手机会一直显示一张已经失效的审批卡，点了还会报错。
            "ui.resolved" -> {
                val resolvedId = data?.get("id")?.jsonPrimitive?.contentOrNull.orEmpty()
                if (resolvedId.isNotEmpty()) {
                    synchronized(lock) { respondedUiIds += resolvedId }
                    if (_view.value.pendingUi?.id == resolvedId) {
                        patch { it.copy(pendingUi = null) }
                    }
                }
            }

            else -> Unit // 其它 kind 本版忽略
        }

        if (seq > 0) synchronized(lock) {
            expectNext = seq + 1
            // 记下基线：下一次重订阅带 sinceSeq 让主机补发，而不是重传快照
            lastSeq = seq
        }
    }

    private fun handleMessageStart(event: JsonObject?, seq: Int) {
        val message = event?.get("message") as? JsonObject ?: return
        val role = message.str("role").orEmpty()
        if (role == "user") {
            // 与主机快照同名（`role-<timestamp>`）：下一轮增量快照的锚点才能对上。
            val hostId = message.str("timestamp")?.toLongOrNull()?.let { "user-$it" }
            // 剥掉 pi 的图片注解：它只在图片被缩放/转换过时出现（大图必中），而下面
            // 「乐观回显转正」是按文本相等对账的——不剥就永远失配，同一条消息会上屏两次。
            // 显示用 dimension（`[Image omitted: …]` 保留，那是给用户看的原因说明），
            // 对账用 hints（5 种注解全剥）。
            val rawText = textOfContent(message["content"])
            val text = stripImageDimensionNotes(rawText)
            val compareText = stripImageHints(rawText)
            // 事件通道不带图片本体（主机只留 {type:image, omitted:true}）：带图的用户消息
            // 本地只能先建纯文本版，必须再拉一次全量快照把图片块补回来。
            val hasMediaPart = contentNeedsMediaBackfill(message["content"])
            // 图片消息可能没有文本（image-only）：这时按「最后一条待发用户消息」转正，
            // 否则那条乐观回显会永远挂在「发送中」。
            val echo = _view.value.messages.lastOrNull { candidate ->
                candidate.pending && candidate.role == "user" &&
                    (compareText.isEmpty() || candidate.blocks.any { it.type == BlockType.Text && it.text == compareText })
            }
            if (compareText.isEmpty() && echo == null) {
                // 别的设备发的纯图片消息：本地没有可显示的文本版，但图片块仍要靠
                // 全量快照补回来（否则要等下一次自然 resync 才可见）。
                if (hasMediaPart) scheduleMediaBackfill()
                return
            }
            // 自己发的媒体：回显里已有本地字节，不用补拉（echoUserMessage 注释）。字面量
            // 可能是图片块也可能是文件占位——只要回显里带了媒体本体就不再补拉。
            val echoHasMedia = echo?.blocks?.any {
                it.type == BlockType.Image || it.type == BlockType.Video || !it.data.isNullOrEmpty()
            } == true
            if (echo != null) {
                patch { view ->
                    view.copy(
                        messages = view.messages.map {
                            if (it.id == echo.id) it.copy(pending = false, id = hostId ?: it.id) else it
                        },
                    )
                }
            } else {
                patch { view ->
                    view.copy(
                        messages = view.messages + ThreadMessage(
                            id = hostId ?: "u-$seq-${view.messages.size}",
                            role = "user",
                            blocks = listOf(MessageBlock(type = BlockType.Text, text = text)),
                        ),
                    )
                }
            }
            if (hasMediaPart && !echoHasMedia) scheduleMediaBackfill()
        } else if (_view.value.streaming == null) {
            patch { it.copy(streaming = ThreadMessage(id = "a-$seq", role = "assistant")) }
        }
    }

    private fun handleMessageEnd(event: JsonObject?) {
        val message = event?.get("message") as? JsonObject ?: return
        if (message.str("role") != "assistant") return
        val streaming = _view.value.streaming ?: return
        val stopReason = message.str("stopReason")
        val errorMessage = message.str("errorMessage")
        // 与主机快照同名（`assistant-<timestamp>`）：主机把连续 assistant 条目折成一个回合，
        // id 取第一条的时间戳——就是这条 message_end 的时间戳。
        val hostId = message.str("timestamp")?.toLongOrNull()?.let { "assistant-$it" }
        patch { view ->
            val finished = streaming.copy(id = hostId ?: streaming.id, stopReason = stopReason, errorMessage = errorMessage)
            // 同一回合可能已经在快照里了（回合中途因附件补拉过）→ **合并**，不能追加。
            //
            // 2026-11-04 真机：桌面 `mpi_attach_file` 发视频，手机停在当前页看不到卡片，
            // 「切走再切回」才出现。链路是：补拉快照（含本回合 + video 块）→ messages 里
            // 已有 `assistant-<ts>` → 回合结束时这里又追加一条同 id 的流式气泡 →
            // ThreadScreen 用 `key = { it.id }`，LazyColumn 的 key **必须唯一**，重复时那一段
            // 可能整个不渲染（用户看到的就是「卡片没出现」）。切走再切回时没有流式气泡参与，
            // 所以正常——这正是当时的现象。
            val existing = view.messages.indexOfFirst { it.id == finished.id }
            val messages = if (existing >= 0) {
                val snap = view.messages[existing]
                view.messages.toMutableList().also { list ->
                    list[existing] = snap.copy(
                        // 正文/工具块以**流式**为准（快照可能停在回合中途，少最后几段）；
                        // 附件类块只能从**快照**来（事件通道只有占位标记）。
                        blocks = mergeRoundBlocks(finished.blocks, snap.blocks),
                        stopReason = finished.stopReason ?: snap.stopReason,
                        errorMessage = finished.errorMessage ?: snap.errorMessage,
                    )
                }
            } else {
                view.messages + finished
            }
            view.copy(
                messages = messages,
                streaming = null,
                errorBanner = if (stopReason == "error") {
                    errorMessage?.takeIf { it.isNotEmpty() } ?: "本轮以错误结束"
                } else {
                    view.errorBanner
                },
            )
        }
    }

    /**
     * 合并「流式气泡的块」与「快照里同一回合的块」。
     *
     * 媒体块（image/video/audio/file）只存在于快照（事件通道只给占位标记）；其它块
     * （text/thinking/tool）以流式那份为准，因为它是最新的。流式那边恰好什么都没有时
     * （纯媒体回合）直接整份用快照的，否则正文会丢。
     */
    private fun mergeRoundBlocks(streamed: List<MessageBlock>, snapshot: List<MessageBlock>): List<MessageBlock> {
        if (snapshot.isEmpty()) return streamed
        val hasStreamedContent = streamed.any {
            it.type == BlockType.Text || it.type == BlockType.Thinking || it.type == BlockType.Tool
        }
        if (!hasStreamedContent) return snapshot
        val media = snapshot.filter {
            it.type == BlockType.Image || it.type == BlockType.Video || it.type == BlockType.Audio || it.type == BlockType.File
        }
        if (media.isEmpty()) return streamed
        val have = streamed.map { it.type to it.name }.toSet()
        return streamed + media.filter { (it.type to it.name) !in have }
    }

    private fun handleContextUsage(data: JsonObject?) {
        if (data == null) return
        val window = data["contextWindow"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
        val model = data["model"] as? JsonObject
        patch { view ->
            view.copy(
                contextUsage = if (window != null) {
                    ContextUsage(
                        tokens = data["tokens"]?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
                        contextWindow = window,
                        percent = data["percent"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull(),
                        estimatedTokens = data["estimatedTokens"]?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
                    )
                } else {
                    view.contextUsage
                },
                // 主机在桥就绪后会补推当前模型；不采纳的话 chip 会一直停在「默认模型」
                model = model?.str("id")?.takeIf { it.isNotEmpty() }
                    ?.let { ModelRef(provider = model.str("provider").orEmpty(), id = it) }
                    ?: view.model,
            )
        }
    }

    /**
     * 交接进度：主机每走一步推一帧，手机端据此显示「正在做什么 + 已等多少秒」。
     * 缺 startedAt 时用本机时间兜底（否则秒表会从 0 重新开始）。
     */
    private fun handleHandoffProgress(data: JsonObject?) {
        val phase = data?.str("phase")?.takeIf { it.isNotEmpty() } ?: return
        patch { view ->
            view.copy(
                handoff = HandoffProgress(
                    phase = phase,
                    startedAt = data["startedAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
                        ?: view.handoff?.startedAt
                        ?: System.currentTimeMillis(),
                    elapsedMs = data["elapsedMs"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0,
                    threadId = data.str("threadId"),
                    docPath = data.str("docPath"),
                    message = data.str("message"),
                ),
            )
        }
    }

    private fun handleConfigChanged(data: JsonObject?) {
        if (data == null) return
        val permission = data.str("permission")
        val hasModel = data.containsKey("model")
        val newModel = (data["model"] as? JsonObject)?.str("id")?.takeIf { it.isNotEmpty() }
            ?.let { ModelRef(data["model"]!!.jsonObject.str("provider").orEmpty(), it) }
        // 桥就绪后主机会补推一份完整列表（磁盘快照那份缺 pi 目录模型）；没有该字段时保持原值。
        val newModels = ThreadModels.decodeModelOptions(data["availableModels"])
        patch { view ->
            view.copy(
                summary = if (permission != null) {
                    view.summary?.copy(permission = RemotePermission.fromWire(permission)) ?: view.summary
                } else {
                    view.summary
                },
                model = if (hasModel) newModel else view.model,
                availableModels = newModels ?: view.availableModels,
                thinkingLevel = if (data.containsKey("thinkingLevel")) {
                    data["thinkingLevel"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }
                } else {
                    view.thinkingLevel
                },
                taskMode = if (data.containsKey("taskMode")) {
                    data["taskMode"]?.jsonPrimitive?.contentOrNull
                } else {
                    view.taskMode
                },
            )
        }
    }

    // ---- 流式增量（节流）----

    private fun queueAssistantDelta(ame: JsonObject) {
        when (ame.str("type")) {
            "text_delta" -> ame.str("delta")?.takeIf { it.isNotEmpty() }?.let { buffer(BlockType.Text, it) }

            "thinking_delta" -> ame.str("delta")?.takeIf { it.isNotEmpty() }?.let { buffer(BlockType.Thinking, it) }

            "toolcall_start", "toolcall_end" -> {
                flushDeltas()
                val contentIndex = ame["contentIndex"]?.jsonPrimitive?.contentOrNull?.toIntOrNull()
                // pi 的 toolcall_start 只给 partial.content[contentIndex].id（不给 toolCall）；
                // toolcall_end 才给 toolCall.id。两边都要看，否则开始时只能用占位 id。
                val toolCall = ame["toolCall"] as? JsonObject
                val partialBlock = contentIndex?.let { index ->
                    ((ame["partial"] as? JsonObject)?.get("content") as? kotlinx.serialization.json.JsonArray)
                        ?.getOrNull(index) as? JsonObject
                }
                val realId = toolCall?.str("id")?.takeIf { it.isNotEmpty() }
                    ?: partialBlock?.str("id")?.takeIf { it.isNotEmpty() }
                val placeholder = contentIndex?.let { "$PLACEHOLDER_TOOL_ID_PREFIX$it" }
                val id = realId ?: placeholder ?: return
                val name = toolCall?.str("name")?.takeIf { it.isNotEmpty() }
                    ?: partialBlock?.str("name")?.takeIf { it.isNotEmpty() }
                    ?: "tool"
                val argsText = summarizeArgs(toolCall?.get("arguments") ?: partialBlock?.get("arguments"))
                upsertToolBlockInStreaming(
                    id = id,
                    // 占位 id：当真 id 出现时，把同一个 contentIndex 的占位块改名而不是新建
                    placeholderId = placeholder?.takeIf { realId != null && it != realId },
                    contentIndex = contentIndex,
                    name = name,
                    argsText = argsText,
                    running = ame.str("type") == "toolcall_start",
                )
            }

            else -> Unit // toolcall_delta 等：本版保留上一次已知状态
        }
    }

    private fun buffer(type: BlockType, delta: String) {
        synchronized(lock) { deltaBuffer += type to delta }
        if (flushJob?.isActive != true) {
            flushJob = scope.launch {
                delay(FLUSH_INTERVAL_MS)
                flushDeltas()
            }
        }
    }

    /** 把缓冲的增量合并提交一次（§1.5 预算 #3）。 */
    private fun flushDeltas() {
        val buffered: List<Pair<BlockType, String>>
        synchronized(lock) {
            if (deltaBuffer.isEmpty()) return
            buffered = deltaBuffer.toList()
            deltaBuffer.clear()
        }
        flushJob?.cancel()
        flushJob = null

        patch { view ->
            val streaming = view.streaming ?: ThreadMessage(
                id = "a-${System.nanoTime()}",
                role = "assistant",
            )
            var blocks = streaming.blocks
            for ((type, delta) in buffered) blocks = appendToLast(blocks, type, delta)
            view.copy(streaming = streaming.copy(blocks = blocks))
        }
    }

    private fun appendToLast(blocks: List<MessageBlock>, type: BlockType, delta: String): List<MessageBlock> {
        val last = blocks.lastOrNull()
        return if (last != null && last.type == type && type != BlockType.Tool) {
            blocks.dropLast(1) + last.copy(text = (last.text ?: "") + delta)
        } else {
            blocks + MessageBlock(type = type, text = delta, running = type == BlockType.Tool)
        }
    }

    private fun markTool(
        id: String,
        running: Boolean? = null,
        text: String? = null,
        isError: Boolean = false,
        name: String? = null,
    ) {
        // 双路径匹配：先按 toolCallId（正常路径，靠 contentIndex 合并已经把 id 对齐）；
        // 再退回「同名且唯一」的运行中工具块——覆盖流中断导致 toolcall_end 没来、
        // 块名还停在占位 id 的情况，否则那一行会永远转圈（真机反馈的「一直在执行中」）。
        patch { view ->
            var claimed = false
            val patchFn: (MessageBlock) -> MessageBlock = { block ->
                if (block.type != BlockType.Tool) {
                    block
                } else if (block.id == id) {
                    claimed = true
                    block.copy(
                        running = running ?: block.running,
                        text = text ?: block.text,
                        isError = isError || block.isError,
                    )
                } else if (
                    !claimed && name != null && block.name == name &&
                    block.running && (block.id?.startsWith(PLACEHOLDER_TOOL_ID_PREFIX) == true)
                ) {
                    claimed = true
                    // 把占位块认领到真 id，后续事件才能命中
                    block.copy(
                        id = id,
                        running = running ?: block.running,
                        text = text ?: block.text,
                        isError = isError || block.isError,
                    )
                } else {
                    block
                }
            }
            view.copy(
                messages = view.messages.map { it.copy(blocks = it.blocks.map(patchFn)) },
                streaming = view.streaming?.let { it.copy(blocks = it.blocks.map(patchFn)) },
            )
        }
    }

    private fun upsertToolBlockInStreaming(
        id: String,
        placeholderId: String? = null,
        contentIndex: Int? = null,
        name: String,
        argsText: String?,
        running: Boolean,
    ) {
        patch { view ->
            val streaming = view.streaming ?: ThreadMessage(id = "a-$id", role = "assistant")
            val blocks = streaming.blocks
            // 定位顺序：真 id → contentIndex（占位块）→ 占位 id。
            // 把占位块**改名合并**到真 id，而不是新建一个——否则每次工具调用都会多出
            // 一行永远转圈的「tool」，真正拿到结果的是另一行（真机反馈的那个 bug）。
            var index = blocks.indexOfFirst { it.type == BlockType.Tool && it.id == id }
            if (index < 0 && contentIndex != null) {
                index = blocks.indexOfFirst { it.type == BlockType.Tool && it.contentIndex == contentIndex }
            }
            if (index < 0 && placeholderId != null) {
                index = blocks.indexOfFirst { it.type == BlockType.Tool && it.id == placeholderId }
            }
            val next = if (index >= 0) {
                val existing = blocks[index]
                blocks.toMutableList().also {
                    it[index] = existing.copy(
                        id = id,
                        name = name,
                        argsText = argsText ?: existing.argsText,
                        contentIndex = contentIndex ?: existing.contentIndex,
                        // toolcall_end 不主动清 running：收口交给 tool_execution_end
                        running = if (running) true else existing.running,
                    )
                }
            } else {
                blocks + MessageBlock(
                    type = BlockType.Tool,
                    id = id,
                    name = name,
                    argsText = argsText,
                    running = running,
                    contentIndex = contentIndex,
                )
            }
            view.copy(streaming = streaming.copy(blocks = next))
        }
    }

    // ---- 工具 ----

    /**
     * 回合收口：结束视图级 running，并把**还标着「运行中」的工具块**一并关掉。
     *
     * 为什么需要：工具启动后若回合被**中断**（用户点停止）或进程退出，`tool_execution_end`
     * 可能永远不来 → 那一行工具永远转圈（「一直在执行中」）。`agent_settled` 是「本回合
     * 彻底结束」的权威信号，此后不可能还有工具在跑，所以在这里收口是安全的。
     *
     * ⚠️ 不能用 `message_end`：assistant 消息结束时工具**尚未执行**（`tool_execution_*`
     * 在其后发生），在那里清会把正在跑的工具误标成完成。
     *
     * 与 PWA 的 ThreadSession.settleTurn 保持同构。
     */
    private fun settleTurn(errorBanner: String? = null) {
        val close: (ThreadMessage) -> ThreadMessage = { message ->
            if (message.blocks.none { it.type == BlockType.Tool && it.running }) {
                message
            } else {
                message.copy(
                    blocks = message.blocks.map { block ->
                        if (block.type == BlockType.Tool && block.running) block.copy(running = false) else block
                    },
                )
            }
        }
        patch { view ->
            view.copy(
                errorBanner = errorBanner ?: view.errorBanner,
                running = false,
                messages = view.messages.map(close),
                streaming = view.streaming?.let(close),
            )
        }
    }

    private fun patch(transform: (ThreadView) -> ThreadView) {
        // 会话已切走（detach 置 closing）：迟到的事件/快照不得再改状态。
        // 这是防线之二——UI 侧还有「不是当前会话就别回写」的校验（见 AppViewModel 的收集器）。
        if (closing) return
        synchronized(lock) { _view.value = transform(_view.value) }
    }

    private fun threadIdPayload(full: Boolean = false): JsonElement =
        kotlinx.serialization.json.buildJsonObject {
            put("threadId", threadId)
            // 增量快照锚点：本地已经有到哪一条（乐观占位不算，主机不认识它们的 id）。
            // 主机在窗口里找得到就只回锚点及其之后（通常几十字节），找不到就回全量。
            // full=true 时故意不带锚点——强制全量，把事件通道省略的图片块补回来。
            if (!full) lastKnownMessageId()?.let { put("haveMessageId", it) }
            // 断线补发基线：主机能补回断线期间的事件时就不回快照（也就不会把正在
            // 流式的内容换掉）。设了“刚应用过快照/刚预热缓存”的场合 lastSeq 已置 null。
            if (!full) lastSeq?.let { put("sinceSeq", it) }
        }

    /**
     * 本地已有的最后一条「主机也认识」的消息 id（增量快照锚点）。
     *
     * **只能取用户消息**（`user-<ts>`）：主机把一轮里连续的 assistant 条目**折叠成一个回合**
     * （id 取第一条的时间戳），面客户端是**每条 message_end 一个气泡**（id 各自的时间戳）。
     * 拿最后一个气泡当锚点 → 工具回合里那个 id 在快照里不存在 → findIndex=-1 → 又回全量。
     * 用最后一个用户消息作锚，代价只是把当前这轮重发一次（几 KB），远优于全量。
     */
    private fun lastKnownMessageId(): String? = pickAnchorId(_view.value.messages)

    /** content 里是否有图片块（事件通道只留标记、不带 data）。 */
    /**
     * 事件里的用户消息是否带来媒体（图片/视频）但拿不到本体。
     *
     * 2026-09-28：原来只认 image → 视频消息永远不触发补拉，手机装了新版也看不到
     * （事件通道会把视频引用剥掉，本地根本不知道这条消息里有视频）。
     */
    /**
     * 这条消息里有没有需要「补拉快照」的媒体占位块。
     *
     * `file` 也得算（2026-11-04 真机）：agent 递交附件时，事件通道只给一个
     * `{type:"file", omitted:true}` 占位块（见主机 withVideoMarkers），真块在快照里。
     * 以前只认 image/video，于是卡片要等下一次自然重订阅才出现（用户感知为“没卡片”）。
     */
    private fun contentNeedsMediaBackfill(content: JsonElement?): Boolean =
        (content as? kotlinx.serialization.json.JsonArray)?.any {
            val part = it as? JsonObject
            val type = part?.str("type")
            type == "image" || type == "video" || type == "file" || type == "audio"
        } ?: false

    /** 带媒体（图/视频）的用户消息 → 一次全量快照补拉（防抖：在途时不重复发）。 */
    private fun scheduleMediaBackfill() {
        if (mediaBackfillPending) return
        mediaBackfillPending = true
        scope.launch {
            try {
                resync(full = true)
            } catch (_: Exception) { /* 失败经 resync 的 errorBanner / onProblem 上报 */ }
            finally {
                mediaBackfillPending = false
            }
        }
    }

    private fun textOfContent(content: JsonElement?): String {
        when (content) {
            null -> return ""
            is JsonPrimitive -> return content.contentOrNull.orEmpty()
            is kotlinx.serialization.json.JsonArray -> return content.mapNotNull { item ->
                (item as? JsonObject)?.str("text")
            }.joinToString("")
            else -> return ""
        }
    }

    private fun summarizeArgs(args: JsonElement?): String? {
        if (args == null || args is kotlinx.serialization.json.JsonNull) return null
        val text = args.toString()
        return if (text.length > 160) text.take(157) + "…" else text
    }

    companion object {
        /** 增量合并间隔（§1.5 预算 #3：约每 60ms 一帧）。 */
        const val FLUSH_INTERVAL_MS = 60L

        /** `toolcall_start` 没拿到真 id 时给工具块用的占位 id 前缀。 */
        const val PLACEHOLDER_TOOL_ID_PREFIX = "tc-"

        /** 等认证就绪的重试上限与间隔（500ms × 30 ≈ 15s）。 */
        private const val READY_RETRY_LIMIT = 30
        private const val READY_RETRY_INTERVAL_MS = 500L

        /**
         * 快照请求（subscribe / resync）的超时。
         *
         * **不能走默认 10s**：会话一大会话快照能到 2MB（真机日志：`rendered=99 sent=99
         * bytes=1.97MB`），中继链路上十几秒都可能——超时后会被当成「连接陈旧」→ 触发
         * 同 socket 重认证（而 R1 之后那条路走不通）→ 重认证风暴、发消息永远「连接未就绪」。
         * 60s 与 PWA 的 SNAPSHOT_TIMEOUT_MS 对齐。
         */
        private const val SNAPSHOT_TIMEOUT_MS = 60_000L

        /**
         * 「等同步」多久算卡住（12s）。
         *
         * 快照正常是中继往返 + 几十~几百 KB 解析，个位数秒；超过这个量还在等，基本可以
         * 肯定帧全在缓冲、界面停在旧内容。只在 [handleEnvelope] 收到帧时检查并上报一次，
         * 不做轮询定时器（免得为了取证反而扰民）。
         */
        private const val SYNC_STALL_MS = 12_000L
    }
}

private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull


private fun JsonObject.bool(key: String): Boolean =
    this[key]?.jsonPrimitive?.contentOrNull == "true"

/**
 * 给用户看的错误文案（纯函数，可单测）：协议层的句子（「无法发送 thread.subscribe 请求
 * （连接未就绪）」）只适合排查，界面上说人话。
 */
internal fun friendlyError(e: Throwable): String {
    if (e is RequestException && e.kind == RequestException.Kind.NotReady) {
        return "连接还没准备好，会继续自动重试"
    }
    if (e is RequestException && e.kind == RequestException.Kind.Timeout) {
        return "等主机回应超时，可点「重新同步」再试"
    }
    return e.message ?: "加载失败"
}

/**
 * 合并增量快照（纯函数，可单测）。
 *
 * 主机带 `incremental` 回来时只给了「锚点那条及其之后」：
 * - **同 id 以新到达的为准**——锚点那条可能在主机侧又长完了/被收口，不覆盖就会永远停在旧版本；
 * - 新 id 追加；
 * - 本地乐观占位（pending，主机不认识）保持原样。
 */
internal fun mergeIncremental(
    current: List<ThreadMessage>,
    incoming: List<ThreadMessage>,
): List<ThreadMessage> {
    if (incoming.isEmpty()) return current
    // 增量快照 = 「从锚点那条（含）开始往后」，所以锚点之后一律以主机这份为准：
    // 事件里长出来的合成 id 消息会在这里被同 id 的主机版覆盖，剩下的丢弃，不留重复气泡；
    // 但**未确认的乐观回显（pending）不能丢**（快照可能产生于它之前）。
    val anchorIndex = current.indexOfFirst { it.id == incoming.first().id }
    val head = if (anchorIndex >= 0) current.take(anchorIndex) else current
    // 锚点找不到时也要留乐观占位（回全量的窗口里同样存在）
    val pendingTail = if (anchorIndex >= 0) current.drop(anchorIndex).filter { it.pending } else current.filter { it.pending }
    val byId = incoming.associateBy { it.id }
    val merged = head.map { byId[it.id] ?: it }
    val seen = merged.mapTo(HashSet()) { it.id }
    val known = head.mapTo(HashSet()) { it.id }
    val tail = incoming.filterNot { it.id in known || it.id in seen }
    tail.forEach { seen += it.id }
    return merged + tail + pendingTail.filterNot { it.id in seen }
}

/**
 * 合并**全量**快照（纯函数，可单测）。
 *
 * 历史以主机为准（主机才是真相源），但**本地还没被主机确认的乐观消息（pending）必须留在末尾**。
 *
 * 为什么（2026-11-05 真机）：「带图片 + 回合进行中 → 发送」走的是 followUp 排队，那条消息
 * 要等当前回合结束才落盘进历史；这段窗口里任何一次全量快照（重连 / seq 缺口 / 媒体补拉 /
 * 缓存对齐）都会把乐观气泡整条替掉——用户看到的就是「消息和图片一起凭空消失」。
 * 增量分支早就有这层保护（见 [mergeIncremental]），全量分支没有——这里补上，与 PWA 同语义。
 *
 * 去重：主机历史里已经有「同文本 + 同媒体块数」的用户消息时，那条占位已被取代，
 * 不能再留一份（否则会多一个气泡）。
 */
internal fun mergeFull(
    current: List<ThreadMessage>,
    incoming: List<ThreadMessage>,
): List<ThreadMessage> {
    val pending = current.filter { it.pending && it.role == "user" }
    if (pending.isEmpty()) return incoming
    val hostLeft = incoming.filter { it.role == "user" }
        .groupingBy { userMessageSignature(it) }.eachCount().toMutableMap()
    val keep = mutableListOf<ThreadMessage>()
    for (message in pending) {
        val key = userMessageSignature(message)
        val left = hostLeft[key] ?: 0
        if (left > 0) hostLeft[key] = left - 1 else keep += message
    }
    return incoming + keep
}

/** 用户消息的「对账签名」：文本 + 媒体块数（主机回显的那条与本地占位用同一个签名）。 */
internal fun userMessageSignature(message: ThreadMessage): String {
    val text = message.blocks.filter { it.type == BlockType.Text }.joinToString("") { it.text.orEmpty() }
    val media = message.blocks.count {
        it.type == BlockType.Image || it.type == BlockType.Video ||
            it.type == BlockType.Audio || it.type == BlockType.File
    }
    return "$text|$media"
}

/**
 * 增量快照的锚点：**最后一条用户消息**的 id（`user-<ts>`）。
 *
 * 为什么不是「最后一条消息」：主机把一轮里连续的 assistant 条目折叠成一个回合（id 取第一条
 * 的时间戳），而客户端是每条 message_end 一个气泡——工具回合里最后那个气泡的 id 在主机快照
 * 里不存在，拿它当锚点必然 miss，于是又回全量（现场 618KB～1.6MB/次）。
 */
internal fun pickAnchorId(messages: List<ThreadMessage>): String? =
    messages.asReversed()
        .firstOrNull { !it.pending && it.id.startsWith("user-") && isHostMessageId(it.id) }
        ?.id?.takeIf { it.isNotEmpty() }

/**
 * 主机发的消息 id 形如 `user-<ts>` / `assistant-<ts>` / `tool-<callId>`（见主机 ipc.ts
 * 的 remoteMessageId）。本地合成的不算：`local-N`、`a-N`、`u-N-M`。
 *
 * ⚠ 能当**增量锚点**的只有 `user-<ts>`（与主机 1:1）；assistant 会被主机折叠成单回合，
 * 后续气泡的 id 在快照里不存在。
 */
internal fun isHostMessageId(id: String): Boolean {
    if (id.isEmpty()) return false
    if (id.startsWith("local-") || id.startsWith("a-") || id.startsWith("u-")) return false
    return Regex("^(user|assistant|system|tool)-").containsMatchIn(id)
}
