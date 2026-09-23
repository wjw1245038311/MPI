package com.mpi.app.data

import com.mpi.app.protocol.RemotePermission
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 发送模式：空闲 → prompt；运行中 → steer；排队到本轮之后 → followUp。 */
enum class SendMode(val method: String) {
    Prompt("prompt"),
    Steer("steer"),
    FollowUp("followUp"),
}

/**
 * 写操作（M2-3）—— 与 PWA 的 `thread-actions.ts` 同构。
 *
 * 主机端的写租约语义（RemoteService）：
 * - `thread.claimWrite` 拿 30s 租约；**他人持有且未过期 → THREAD_BUSY**
 * - prompt/steer/followUp/abort/setPermission/ui.respond 都过 assertWriter：
 *   无租约或已过期 → **WRITE_CLAIM_REQUIRED**；成功则滑动续期 30s
 * - 连接断开时主机删掉该连接的租约 → **重连后必须重新 claim**
 *
 * 本端策略：本地记 claim 时间，用到租期的 [REFRESH_FRACTION] 就提前重取；
 * 写操作遇到 WRITE_CLAIM_REQUIRED（自己的租约过期或被断连清掉）→ **强制重取一次并重试**；
 * 遇到 THREAD_BUSY（别的设备正持有）→ **不抢占**，原样上报给 UI 提示。
 */
class ThreadActions(
    private val threadId: String,
    private val request: suspend (type: String, payload: JsonElement?, threadId: String?, timeoutMs: Long?) -> JsonElement?,
    private val leaseMs: Long = DEFAULT_LEASE_MS,
    private val clock: () -> Long = System::currentTimeMillis,
    /** 每次成功 claim 后回调（初始与续期都算）。 */
    private val onClaim: () -> Unit = {},
) {
    private var claimedAt = 0L

    /** 发一条消息（可带图片/文件附件）。mode 决定走 prompt / steer / followUp。 */
    suspend fun send(
        text: String,
        mode: SendMode,
        images: List<JsonObject> = emptyList(),
        files: List<JsonObject> = emptyList(),
    ): JsonElement? {
        val trimmed = text.trim()
        if (trimmed.isEmpty() && images.isEmpty() && files.isEmpty()) {
            throw IllegalArgumentException("消息不能为空")
        }
        val payload = buildJsonObject {
            put("text", trimmed)
            if (images.isNotEmpty()) put("images", kotlinx.serialization.json.JsonArray(images))
            if (files.isNotEmpty()) put("files", kotlinx.serialization.json.JsonArray(files))
        }
        return writeRequest("thread.${mode.method}", payload, mode.method)
    }

    suspend fun abort(): JsonElement? = writeRequest("thread.abort", buildJsonObject { }, "abort")

    /** 重命名会话（需要写租约）。 */
    suspend fun renameThread(name: String): JsonElement? = writeRequest(
        "thread.rename",
        buildJsonObject { put("name", name) },
        "rename",
    )

    /** 置顶 / 取消置顶（配置级操作，不需要写租约）。 */
    suspend fun setPinned(pinned: Boolean): JsonElement? = request(
        "thread.setPinned",
        buildJsonObject { put("pinned", pinned) },
        threadId,
        null,
    )

    /** 删除会话（主机把它移入回收站；需要写租约）。 */
    suspend fun deleteThread(): JsonElement? = writeRequest("thread.delete", buildJsonObject { }, "delete")

    suspend fun setPermission(permission: RemotePermission): JsonElement? = writeRequest(
        "thread.setPermission",
        buildJsonObject { put("permission", if (permission == RemotePermission.Full) "full" else "sandbox") },
        "setPermission",
    )

    suspend fun setModel(provider: String, modelId: String): JsonElement? = writeRequest(
        "thread.setModel",
        buildJsonObject {
            put("provider", provider)
            put("modelId", modelId)
        },
        "setModel",
    )

    /** 思考档位（off / minimal / low / …）。主机按当前模型可选档位校验。 */
    suspend fun setThinking(level: String): JsonElement? = writeRequest(
        "thread.setThinking",
        buildJsonObject { put("level", level) },
        "setThinking",
    )

    /** modeId 传空串 = 清除模式回到基线。 */
    suspend fun setMode(modeId: String): JsonElement? = writeRequest(
        "thread.setMode",
        buildJsonObject { put("modeId", modeId) },
        "setMode",
    )

    /**
     * 压缩上下文。要读整个会话再调一次 LLM，可能秒级到十几秒，
     * 所以超时放宽到 3 分钟；界面上的「压缩中」由 compaction_start/end 事件驱动。
     */
    suspend fun compact(instructions: String? = null): JsonElement? = writeRequest(
        "thread.compact",
        buildJsonObject { if (!instructions.isNullOrBlank()) put("instructions", instructions) },
        "compact",
        timeoutMs = COMPACT_TIMEOUT_MS,
    )

    /** 回答审批卡。形状对齐桌面端 ExtUiModal：select→{value} / confirm→{confirmed} / input→{value} / cancel→{cancelled:true}。 */
    suspend fun respondUi(requestId: String, response: JsonObject): JsonElement? = writeRequest(
        "ui.respond",
        buildJsonObject {
            put("requestId", requestId)
            put("response", response)
        },
        "respondUi",
    )

    // ---- 内部 ----

    private fun claimValid(): Boolean = clock() - claimedAt < leaseMs * REFRESH_FRACTION

    private suspend fun ensureClaim(force: Boolean = false) {
        if (!force && claimValid()) return
        request("thread.claimWrite", buildJsonObject { }, threadId, null)
        claimedAt = clock()
        onClaim()
    }

    private suspend fun writeRequest(
        type: String,
        payload: JsonObject,
        label: String,
        timeoutMs: Long? = null,
    ): JsonElement? {
        try {
            ensureClaim()
            val result = request(type, payload, threadId, timeoutMs)
            // 主机在每次成功写入后滑动续期，本地也跟着更新
            claimedAt = clock()
            return result
        } catch (e: RequestException) {
            if (e.code != WRITE_CLAIM_REQUIRED) throw e
            // 自己的租约过期/被断连清掉 —— 强制重取一次再重试
            ensureClaim(force = true)
            val result = request(type, payload, threadId, timeoutMs)
            claimedAt = clock()
            return result
        }
    }

    companion object {
        /** 与主机端 service.ts 的租期一致。 */
        const val DEFAULT_LEASE_MS = 30_000L

        /** 用到租期的这个比例就提前续期。 */
        const val REFRESH_FRACTION = 0.8

        /** 主机返回：需要（重新）获取写租约。 */
        const val WRITE_CLAIM_REQUIRED = "WRITE_CLAIM_REQUIRED"

        /** 主机返回：其它设备正持有写租约 —— 不抢占。 */
        const val THREAD_BUSY = "THREAD_BUSY"

        const val COMPACT_TIMEOUT_MS = 180_000L
    }
}
