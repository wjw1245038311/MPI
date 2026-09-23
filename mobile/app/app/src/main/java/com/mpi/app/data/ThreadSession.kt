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
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
    val taskMode: String? = null,
    val availableModes: List<TaskModeOption> = emptyList(),
    val contextUsage: ContextUsage? = null,
    val compacting: Boolean = false,
    /** 待处理的审批/询问卡；**重连后仍要显示**（主机在等回应，弹窗没关）。 */
    val pendingUi: UiRequest? = null,
) {
    /** 列表要渲染的全部消息（历史 + 流式中）。 */
    val renderable: List<ThreadMessage>
        get() = if (streaming != null) messages + streaming else messages
}

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
    private val request: suspend (type: String, payload: JsonElement?, threadId: String?) -> JsonElement?,
    private val scope: CoroutineScope,
) {
    private val _view = MutableStateFlow(ThreadView(threadId = threadId))
    val view: StateFlow<ThreadView> = _view.asStateFlow()

    private val lock = Any()
    private val pendingEvents = mutableListOf<Pair<Int, JsonObject>>()
    private val deltaBuffer = mutableListOf<Pair<BlockType, String>>()
    private var flushJob: Job? = null
    private var expectNext: Int? = null
    private val respondedUiIds = mutableSetOf<String>()
    private var closing = false

    private val unsubscribe = transport.onEnvelope { envelope -> handleEnvelope(envelope) }

    /** 订阅并取快照。重复调用是安全的（用于重连后重新同步）。 */
    suspend fun subscribe() {
        val payload = try {
            request("thread.subscribe", threadIdPayload(), threadId)
        } catch (e: Exception) {
            _view.value = _view.value.copy(ready = true, errorBanner = e.message ?: "订阅失败")
            throw e
        }
        applySnapshot(payload)
    }

    /** 重新同步（seq 缺口或重连后）。 */
    suspend fun resync() {
        val payload = try {
            request("thread.resync", threadIdPayload(), threadId)
        } catch (e: Exception) {
            _view.value = _view.value.copy(errorBanner = e.message ?: "同步失败")
            throw e
        }
        applySnapshot(payload)
    }

    /**
     * 乐观回显：点发送后立刻上屏，不等主机回执（§1.1「点击到视觉反馈 < 100ms」）。
     * 主机回执到达时由 [applyEvent] 的 message_start 把这条「转正」，避免重复上屏。
     */
    fun echoUserMessage(text: String): String {
        val id = "u-local-${System.nanoTime()}"
        synchronized(lock) {
            _view.value = _view.value.copy(
                messages = _view.value.messages + ThreadMessage(
                    id = id,
                    role = "user",
                    pending = true,
                    blocks = listOf(MessageBlock(type = BlockType.Text, text = text)),
                ),
            )
        }
        return id
    }

    /** 把某条乐观消息标记为失败（发送失败时保留在原位并给重试，见 §1.1）。 */
    fun markSendFailed(localId: String, reason: String) {
        synchronized(lock) {
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
            // 快照之前的事件先缓冲（主机先注册监听再取快照，所以不丢不乱）
            if (!_view.value.ready) {
                pendingEvents += seq to payload
                return
            }
            val expected = expectNext
            if (seq > 0 && expected != null) {
                if (seq < expected) return // 重复/过期，忽略
                if (seq > expected) {
                    // 缺了一段 —— 立即重新同步，绝不带着缺口继续渲染
                    scope.launch { runCatching { resync() } }
                    return
                }
            }
        }
        applyEvent(payload, seq)
    }

    private fun applySnapshot(payload: JsonElement?) {
        val snapshot = ThreadModels.decodeSnapshot(payload)
        val buffered: List<Pair<Int, JsonObject>>
        synchronized(lock) {
            buffered = pendingEvents.toList()
            pendingEvents.clear()
            _view.value = _view.value.copy(
                ready = true,
                summary = snapshot.summary,
                // 快照是权威历史：残留的乐观占位一并丢弃
                messages = snapshot.messages,
                streaming = null,
                running = snapshot.summary.state == RemoteThreadState.Running,
                errorBanner = null,
                model = snapshot.model,
                availableModels = snapshot.availableModels,
                taskMode = snapshot.taskMode,
                availableModes = snapshot.availableModes,
                contextUsage = snapshot.contextUsage,
                // 快照到达即认为压缩结束：真在压缩时后面的 compaction_end 会纠正，
                // 而漏掉一个 end 会让按钮永远转圈
                compacting = false,
                // 待处理审批卡要保留：主机还开着那个弹窗
                pendingUi = _view.value.pendingUi,
            )
            // 重新定位 seq 基线；第一条实时事件会重新建立期望值
            expectNext = null
        }
        for ((seq, event) in buffered) applyEvent(event, seq)
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
                event?.str("toolCallId")?.let { id -> markTool(id, running = true) }
            }

            "tool_execution_end" -> {
                val id = event?.str("toolCallId")
                if (id != null) {
                    val result = textOfContent((event["result"] as? JsonObject)?.get("content"))
                    markTool(id, running = false, text = result, isError = event.bool("isError"))
                }
            }

            "message_end" -> handleMessageEnd(event)

            "agent_settled" -> patch { it.copy(running = false) }

            "thread.error" -> {
                val message = data?.str("message") ?: "远程错误"
                patch { it.copy(errorBanner = message, running = false) }
            }

            "thread.exit" -> {
                val code = data?.get("code")?.jsonPrimitive?.contentOrNull
                patch { it.copy(errorBanner = "进程已退出${code?.let { "（code $it）" } ?: ""}", running = false) }
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

            "config_changed" -> handleConfigChanged(data)

            "ui.request" -> {
                val request = ThreadModels.decodeUiRequest(data?.get("request"))
                if (request != null && request.id !in respondedUiIds && _view.value.pendingUi?.id != request.id) {
                    patch { it.copy(pendingUi = request) }
                }
            }

            else -> Unit // 其它 kind 本版忽略
        }

        if (seq > 0) synchronized(lock) { expectNext = seq + 1 }
    }

    private fun handleMessageStart(event: JsonObject?, seq: Int) {
        val message = event?.get("message") as? JsonObject ?: return
        val role = message.str("role").orEmpty()
        if (role == "user") {
            val text = textOfContent(message["content"])
            if (text.isEmpty()) return
            // 先看能不能把本地的乐观回显「转正」，否则同一条消息会上屏两次
            val echo = _view.value.messages.lastOrNull { candidate ->
                candidate.pending && candidate.role == "user" &&
                    candidate.blocks.any { it.type == BlockType.Text && it.text == text }
            }
            if (echo != null) {
                patch { view ->
                    view.copy(
                        messages = view.messages.map {
                            if (it.id == echo.id) it.copy(pending = false) else it
                        },
                    )
                }
            } else {
                patch { view ->
                    view.copy(
                        messages = view.messages + ThreadMessage(
                            id = "u-$seq-${view.messages.size}",
                            role = "user",
                            blocks = listOf(MessageBlock(type = BlockType.Text, text = text)),
                        ),
                    )
                }
            }
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
        patch { view ->
            view.copy(
                messages = view.messages + streaming.copy(stopReason = stopReason, errorMessage = errorMessage),
                streaming = null,
                errorBanner = if (stopReason == "error") {
                    errorMessage?.takeIf { it.isNotEmpty() } ?: "本轮以错误结束"
                } else {
                    view.errorBanner
                },
            )
        }
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

    private fun handleConfigChanged(data: JsonObject?) {
        if (data == null) return
        val permission = data.str("permission")
        val hasModel = data.containsKey("model")
        val newModel = (data["model"] as? JsonObject)?.str("id")?.takeIf { it.isNotEmpty() }
            ?.let { ModelRef(data["model"]!!.jsonObject.str("provider").orEmpty(), it) }
        patch { view ->
            view.copy(
                summary = if (permission != null) {
                    view.summary?.copy(permission = RemotePermission.fromWire(permission)) ?: view.summary
                } else {
                    view.summary
                },
                model = if (hasModel) newModel else view.model,
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
                val toolCall = ame["toolCall"] as? JsonObject
                val id = toolCall?.str("id")?.takeIf { it.isNotEmpty() }
                    ?: ame["contentIndex"]?.jsonPrimitive?.contentOrNull?.let { "tc-$it" }
                    ?: return
                val name = toolCall?.str("name")?.takeIf { it.isNotEmpty() } ?: "tool"
                val argsText = summarizeArgs(toolCall?.get("arguments"))
                upsertToolBlockInStreaming(
                    id = id,
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

    private fun markTool(id: String, running: Boolean? = null, text: String? = null, isError: Boolean = false) {
        val patchFn: (MessageBlock) -> MessageBlock = { block ->
            if (block.type == BlockType.Tool && block.id == id) {
                block.copy(
                    running = running ?: block.running,
                    text = text ?: block.text,
                    isError = isError || block.isError,
                )
            } else {
                block
            }
        }
        patch { view ->
            view.copy(
                messages = view.messages.map { it.copy(blocks = it.blocks.map(patchFn)) },
                streaming = view.streaming?.let { it.copy(blocks = it.blocks.map(patchFn)) },
            )
        }
    }

    private fun upsertToolBlockInStreaming(id: String, name: String, argsText: String?, running: Boolean) {
        patch { view ->
            val streaming = view.streaming ?: ThreadMessage(id = "a-$id", role = "assistant")
            val index = streaming.blocks.indexOfFirst { it.type == BlockType.Tool && it.id == id }
            val blocks = if (index >= 0) {
                val existing = streaming.blocks[index]
                streaming.blocks.toMutableList().also {
                    it[index] = existing.copy(
                        name = name,
                        argsText = argsText ?: existing.argsText,
                        running = if (running) true else existing.running,
                    )
                }
            } else {
                streaming.blocks + MessageBlock(
                    type = BlockType.Tool,
                    id = id,
                    name = name,
                    argsText = argsText,
                    running = running,
                )
            }
            view.copy(streaming = streaming.copy(blocks = blocks))
        }
    }

    // ---- 工具 ----

    private fun patch(transform: (ThreadView) -> ThreadView) {
        synchronized(lock) { _view.value = transform(_view.value) }
    }

    private fun threadIdPayload(): JsonElement =
        kotlinx.serialization.json.buildJsonObject { put("threadId", threadId) }

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
    }
}

private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

private fun JsonObject.bool(key: String): Boolean =
    this[key]?.jsonPrimitive?.contentOrNull == "true"
