package com.mpi.app.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * 主机会话数据模型 —— 字段与 `mobile/shared/protocol.ts` 的 `RemoteProject` /
 * `RemoteThreadSummary` 对齐。
 *
 * **分两层**：线格式 DTO（字段是字符串）+ 领域模型（枚举）。
 * 这样主机将来新增一个 `state` 取值时，手机端会落到 [RemoteThreadState.Unknown]
 * 而不是抛异常崩溃——客户端不该因为服务端加了个枚举值就挂掉。
 */

enum class RemotePermission {
    Sandbox,
    Full,
    ;

    companion object {
        /** 未知取值一律按沙盒处理：宁可少权限，不要多给。 */
        fun fromWire(value: String): RemotePermission = when (value) {
            "full" -> Full
            "sandbox" -> Sandbox
            else -> Sandbox
        }
    }
}

enum class RemoteThreadState {
    Draft,
    Idle,
    Running,
    Error,
    Disconnected,

    /** 主机给了本端不认识的取值（协议演进）。UI 需要为它准备一个兜底显示。 */
    Unknown,
    ;

    companion object {
        fun fromWire(value: String): RemoteThreadState = when (value) {
            "draft" -> Draft
            "idle" -> Idle
            "running" -> Running
            "error" -> Error
            "disconnected" -> Disconnected
            else -> Unknown
        }
    }
}

data class RemoteProject(
    val id: String,
    val name: String,
    val threadCount: Int,
    val updatedAt: Long,
)

data class RemoteThreadSummary(
    val id: String,
    val projectId: String,
    val title: String,
    val preview: String,
    val updatedAt: Long,
    val messageCount: Int,
    val state: RemoteThreadState,
    val permission: RemotePermission,
)

// ---- 线格式 DTO（除 id 外都有默认值，容忍主机端字段增删）----

@Serializable
internal data class ProjectDto(
    val id: String,
    val name: String = "",
    val threadCount: Int = 0,
    val updatedAt: Long = 0,
)

@Serializable
internal data class ThreadSummaryDto(
    val id: String,
    val projectId: String = "",
    val title: String = "",
    val preview: String = "",
    val updatedAt: Long = 0,
    val messageCount: Int = 0,
    val state: String = "",
    val permission: String = "",
)

object RemoteModels {
    private val json = Json { ignoreUnknownKeys = true }

    /** 解析 `projects.list` 的 payload。缺字段/类型不符时抛 [RemoteProtocolException]。 */
    fun decodeProjects(payload: JsonElement?): List<RemoteProject> {
        val array = arrayField(payload, "projects") ?: return emptyList()
        return array.map { element ->
            val dto = decode<ProjectDto>(element, "project")
            RemoteProject(id = dto.id, name = dto.name, threadCount = dto.threadCount, updatedAt = dto.updatedAt)
        }
    }

    /** 解析 `threads.list` 的 payload。 */
    fun decodeThreads(payload: JsonElement?): List<RemoteThreadSummary> {
        val array = arrayField(payload, "threads") ?: return emptyList()
        return array.map { element ->
            val dto = decode<ThreadSummaryDto>(element, "thread")
            RemoteThreadSummary(
                id = dto.id,
                projectId = dto.projectId,
                title = dto.title,
                preview = dto.preview,
                updatedAt = dto.updatedAt,
                messageCount = dto.messageCount,
                state = RemoteThreadState.fromWire(dto.state),
                permission = RemotePermission.fromWire(dto.permission),
            )
        }
    }

    private fun arrayField(payload: JsonElement?, key: String): JsonArray? {
        val obj = payload as? JsonObject ?: return null
        return obj[key] as? JsonArray
    }

    /**
     * 严格解析单个元素：我们自己的主机产出的数据，格式不对说明有协议缺陷，
     * 应当**报错让人看到**，而不是悄悄丢掉这一条（§1.1 不静默失败）。
     */
    private inline fun <reified T> decode(element: JsonElement, what: String): T = try {
        json.decodeFromString<T>(element.toString())
    } catch (e: Exception) {
        throw RemoteProtocolException("INVALID_PAYLOAD", "$what 数据格式不合法：${e.message}")
    }
}
