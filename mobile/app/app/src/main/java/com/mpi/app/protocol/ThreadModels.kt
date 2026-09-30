package com.mpi.app.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * 会话视图模型（M2）—— 字段与 `mobile/shared/protocol.ts` 的
 * `RemoteThreadSnapshot` / `RemoteMessage` / `RemoteUiRequest` 对齐。
 *
 * 同样分「线格式 DTO + 领域模型」两层：块类型、状态、方法名都可能在主机端演进，
 * 未知取值要落到安全的兜底值而不是抛异常。
 */

// ---- 消息块 ----

enum class BlockType {
    Text,
    Thinking,
    Tool,
    Image,
    /** 视频附件（主机内联下发的 base64）。UI 侧渲染成播放器，见 ThreadScreen 的 VideoBlock。 */
    Video,
    /**
     * 音频附件（P3）：主机只下发**元数据**（name/label/size），字节点开/播放时才拉。
     * 与视频同一套取字节入口（直连读 URL 优先、中继分片回落）。
     */
    Audio,
    ;

    companion object {
        /** 未知块类型按文本处理（最保守：至少让人看到内容，而不是整块消失）。 */
        fun fromWire(value: String): BlockType = when (value) {
            "text" -> Text
            "thinking" -> Thinking
            "tool" -> Tool
            "image" -> Image
            "video" -> Video
            "audio" -> Audio
            else -> Text
        }
    }
}

data class MessageBlock(
    val type: BlockType,
    /** 文本内容；工具块这里是**执行结果**（历史快照里工具块的结果放在 result 字段）。 */
    val text: String? = null,
    /** 工具名（如 `bash` / `read`）。 */
    val name: String? = null,
    /** 工具是否仍在运行。 */
    val running: Boolean = false,
    /** 工具调用参数（主机侧压成一行）。 */
    val argsText: String? = null,
    /** 图片/视频块的数据（data URL 或裸 base64）。 */
    val data: String? = null,
    val mimeType: String? = null,
    /** 视频原始字节数（video 块用，占位卡片上显示大小）。 */
    val size: Long? = null,
    /**
     * 视频的**首帧封面**（base64 图片）。快照不再下发视频本体后，气泡里的画面就靠它；
     * 没有封面（旧消息 / 发送端抽帧失败）→ 退化成深色卡片 + ▶，照样可点开按需拉。
     */
    val poster: String? = null,
    val posterMimeType: String? = null,
    /** 主机刻意没下发本体（实时事件通道防大帧，或超出快照视频预算）→ 渲染占位卡片。 */
    val omitted: Boolean = false,
    /**
     * 可读的原文件名（P3）：内容寻址后 `name` 是 64 位哈希，界面上显示它没有意义。
     * 老消息没这个字段 → 回落到 `name`。
     */
    val label: String? = null,
    /** 工具调用 id —— 流式事件按它定位到具体块。 */
    val id: String? = null,
    /** 工具是否以失败结束。 */
    val isError: Boolean = false,
    /**
     * 工具块在助消息内容数组中的下标（仅流式期间有意义）。
     *
     * pi 的 `toolcall_start` 只带 `partial.content[contentIndex]`（带 id），不带 `toolCall`；
     * `toolcall_end` 才带 `toolCall.id`。所以开始时只能用 `tc-<contentIndex>` 占位 id，
     * 靠这个下标把占位块**改名合并**到真 id——否则同一次调用会留下两个块
     * （一个永远「执行中」的占位块 + 一个真正拿到结果的块）。
     */
    val contentIndex: Int? = null,
)

data class MessageArtifact(
    val name: String,
    val path: String,
    val ext: String = "",
    val action: String = "",
)

data class ThreadMessage(
    val id: String,
    val role: String,
    /** 乐观回显：本机刚发、主机还没回执的本地占位消息。 */
    val pending: Boolean = false,
    val blocks: List<MessageBlock> = emptyList(),
    val artifacts: List<MessageArtifact> = emptyList(),
    val stopReason: String? = null,
    val errorMessage: String? = null,
    val timestamp: Long? = null,
)

// ---- 会话配置（chip 行与审批卡用）----

data class ModelRef(val provider: String, val id: String)

data class ModelOption(val provider: String, val id: String, val name: String? = null, val reasoning: Boolean = false)

data class TaskModeOption(
    val id: String,
    val name: String,
    val summary: String? = null,
    /** 硬只读下限（研究 / 审查模式）——手机端要如实显示。 */
    val enforceReadonly: Boolean = false,
)

data class ContextUsage(
    val tokens: Long? = null,
    val contextWindow: Long = 0,
    val percent: Double? = null,
    val estimatedTokens: Long? = null,
)

/** 审批/询问请求（主机端的 ui.request）。 */
data class UiRequest(
    val id: String,
    /** confirm / select / input / editor / notify；未知值按 confirm 处理。 */
    val method: String,
    val title: String? = null,
    val message: String? = null,
    val options: List<String> = emptyList(),
    val placeholder: String? = null,
    val prefill: String? = null,
    /** write/edit 类审批附带的结构化 diff（§4.5）；没有则为 null。 */
    val diff: UiDiff? = null,
) {
    val isSelect: Boolean get() = method == "select" && options.isNotEmpty()
    val isInput: Boolean get() = method == "input" || method == "editor"
}

data class UiDiff(
    val path: String,
    val added: Int = 0,
    val removed: Int = 0,
    val hunks: String = "",
    /** 主机因体积截断了 diff 内容。 */
    val truncated: Boolean = false,
)

// ---- 快照 ----

data class ThreadSnapshot(
    val summary: RemoteThreadSummary,
    val cwdName: String = "",
    val model: ModelRef? = null,
    val availableModels: List<ModelOption> = emptyList(),
    val thinkingLevel: String = "",
    /** 当前模型可选的思考档位；主机未上报时为空（客户端自行推断）。 */
    val thinkingLevels: List<String> = emptyList(),
    val taskMode: String? = null,
    val availableModes: List<TaskModeOption> = emptyList(),
    val contextUsage: ContextUsage? = null,
    val messages: List<ThreadMessage> = emptyList(),
    /** true = 只带新增（含锚点那条），按 id 合并而不是整体替换。 */
    val incremental: Boolean = false,
    val nextSeq: Int = 0,
)

// ---- 线格式 DTO ----

@Serializable
internal data class BlockDto(
    val type: String = "text",
    val text: String? = null,
    val name: String? = null,
    val running: Boolean? = null,
    val result: String? = null,
    val args: String? = null,
    val data: String? = null,
    val mimeType: String? = null,
    val size: Long? = null,
    val poster: String? = null,
    val posterMimeType: String? = null,
    val label: String? = null,
    val omitted: Boolean? = null,
    val isError: Boolean? = null,
    val id: String? = null,
)

@Serializable
internal data class ArtifactDto(val name: String, val path: String = "", val ext: String = "", val action: String = "")

@Serializable
internal data class MessageDto(
    val id: String,
    val role: String = "assistant",
    val blocks: List<BlockDto> = emptyList(),
    val artifacts: List<ArtifactDto> = emptyList(),
    val timestamp: Long? = null,
    val stopReason: String? = null,
    val errorMessage: String? = null,
)

@Serializable
internal data class ModelRefDto(val provider: String = "", val id: String = "")

@Serializable
internal data class ModelOptionDto(
    val provider: String = "",
    val id: String = "",
    val name: String? = null,
    val reasoning: Boolean = false,
)

@Serializable
internal data class TaskModeDto(
    val id: String = "",
    val name: String = "",
    val summary: String? = null,
    val enforce: String? = null,
)

@Serializable
internal data class ContextUsageDto(
    val tokens: Long? = null,
    val contextWindow: Long = 0,
    val percent: Double? = null,
    val estimatedTokens: Long? = null,
)

@Serializable
internal data class DiffDto(
    val path: String = "",
    val added: Int = 0,
    val removed: Int = 0,
    val hunks: String = "",
    val truncated: Boolean = false,
)

@Serializable
internal data class UiRequestDto(
    val id: String = "",
    val method: String = "confirm",
    val title: String? = null,
    val message: String? = null,
    val options: List<String> = emptyList(),
    val placeholder: String? = null,
    val prefill: String? = null,
    val diff: DiffDto? = null,
)

@Serializable
internal data class ThreadSnapshotDto(
    val id: String,
    val projectId: String = "",
    val title: String = "",
    val preview: String = "",
    val updatedAt: Long = 0,
    val messageCount: Int = 0,
    val state: String = "",
    val permission: String = "",
    val cwdName: String = "",
    val model: ModelRefDto? = null,
    val availableModels: List<ModelOptionDto> = emptyList(),
    val thinkingLevel: String = "",
    val thinkingLevels: List<String> = emptyList(),
    val taskMode: String? = null,
    val availableModes: List<TaskModeDto> = emptyList(),
    val contextUsage: ContextUsageDto? = null,
    val messages: List<MessageDto> = emptyList(),
    val incremental: Boolean = false,
    val nextSeq: Int = 0,
)

object ThreadModels {
    private val json = Json { ignoreUnknownKeys = true }

    fun decodeSnapshot(payload: kotlinx.serialization.json.JsonElement?): ThreadSnapshot {
        val obj = payload as? kotlinx.serialization.json.JsonObject
            ?: throw RemoteProtocolException("INVALID_PAYLOAD", "快照响应不是对象")
        val snapshotElement = obj["snapshot"]
            ?: throw RemoteProtocolException("INVALID_PAYLOAD", "快照响应缺少 snapshot")
        val dto = try {
            json.decodeFromString(ThreadSnapshotDto.serializer(), snapshotElement.toString())
        } catch (e: Exception) {
            throw RemoteProtocolException("INVALID_PAYLOAD", "快照格式不合法：${e.message}")
        }
        return dto.toDomain()
    }

    /**
     * 解析 `config_changed` 里补推的 availableModels。
     *
     * 返回 null 表示事件里**没有**这个字段（保持端上原值不变）；空列表也算有效值。
     * 为什么单独一条：磁盘快照（history-first）的列表只带配置模型，缺 pi 目录里那份，
     * 桥就绪后主机补推一次完整列表（2026-09-26 真机：chip 显示裸 id、列表里找不到当前模型）。
     */
    fun decodeModelOptions(element: kotlinx.serialization.json.JsonElement?): List<ModelOption>? {
        if (element == null || element is kotlinx.serialization.json.JsonNull) return null
        val dto = runCatching { json.decodeFromString<List<ModelOptionDto>>(element.toString()) }
            .getOrNull() ?: return null
        return dto.filter { it.id.isNotEmpty() }.map { ModelOption(it.provider, it.id, it.name, it.reasoning) }
    }

    fun decodeUiRequest(element: kotlinx.serialization.json.JsonElement?): UiRequest? {        if (element == null) return null
        val dto = runCatching { json.decodeFromString(UiRequestDto.serializer(), element.toString()) }
            .getOrNull() ?: return null
        if (dto.id.isEmpty()) return null
        return UiRequest(
            id = dto.id,
            method = dto.method,
            title = dto.title,
            message = dto.message,
            options = dto.options,
            placeholder = dto.placeholder,
            prefill = dto.prefill,
            diff = dto.diff?.let {
                UiDiff(path = it.path, added = it.added, removed = it.removed, hunks = it.hunks, truncated = it.truncated)
            },
        )
    }

    internal fun ThreadSnapshotDto.toDomain(): ThreadSnapshot = ThreadSnapshot(
        summary = RemoteThreadSummary(
            id = id,
            projectId = projectId,
            title = title,
            preview = preview,
            updatedAt = updatedAt,
            messageCount = messageCount,
            state = RemoteThreadState.fromWire(state),
            permission = RemotePermission.fromWire(permission),
        ),
        cwdName = cwdName,
        model = model?.takeIf { it.id.isNotEmpty() }?.let { ModelRef(it.provider, it.id) },
        availableModels = availableModels.filter { it.id.isNotEmpty() }.map { ModelOption(it.provider, it.id, it.name, it.reasoning) },
        thinkingLevel = thinkingLevel,
        thinkingLevels = thinkingLevels.filter { it.isNotBlank() },
        taskMode = taskMode,
        availableModes = availableModes.filter { it.id.isNotEmpty() }
            .map { TaskModeOption(it.id, it.name, it.summary, it.enforce == "readonly") },
        contextUsage = contextUsage?.let { ContextUsage(it.tokens, it.contextWindow, it.percent, it.estimatedTokens) },
        messages = messages.map { it.toDomain() },
        incremental = incremental,
        nextSeq = nextSeq,
    )

    internal fun MessageDto.toDomain(): ThreadMessage = ThreadMessage(
        id = id,
        role = role,
        blocks = blocks.map { it.toDomain() },
        artifacts = artifacts.map { MessageArtifact(it.name, it.path, it.ext, it.action) },
        stopReason = stopReason,
        errorMessage = errorMessage,
        timestamp = timestamp,
    )

    internal fun BlockDto.toDomain(): MessageBlock {
        val type = BlockType.fromWire(type)
        return MessageBlock(
            type = type,
            // 历史快照里工具块的正文是 result（PWA 踩过：曾取 text 导致展开后空白）
            text = if (type == BlockType.Tool) result else text,
            name = name,
            running = running == true,
            argsText = args,
            data = data,
            mimeType = mimeType,
            size = size,
            poster = poster,
            posterMimeType = posterMimeType,
            label = label,
            omitted = omitted == true,
            id = id,
            isError = isError == true,
        )
    }
}
