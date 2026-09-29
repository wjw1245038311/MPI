package com.mpi.app.data

import com.mpi.app.protocol.RemotePermission
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream

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

    /** 发一条消息（可带图片/文件/视频附件）。mode 决定走 prompt / steer / followUp。 */
    suspend fun send(
        text: String,
        mode: SendMode,
        images: List<JsonObject> = emptyList(),
        files: List<JsonObject> = emptyList(),
        videos: List<JsonObject> = emptyList(),
    ): JsonElement? {
        val trimmed = text.trim()
        if (trimmed.isEmpty() && images.isEmpty() && files.isEmpty() && videos.isEmpty()) {
            throw IllegalArgumentException("消息不能为空")
        }
        val payload = buildJsonObject {
            put("text", trimmed)
            if (images.isNotEmpty()) put("images", kotlinx.serialization.json.JsonArray(images))
            if (files.isNotEmpty()) put("files", kotlinx.serialization.json.JsonArray(files))
            // 视频单独走 videos：主机据此当成**可播放媒体**（files 里的视频只是给 agent 读的文件），
            // 且接受 `storedName`（直连上传完成，字节不进这一帧）。见 PWA thread-actions.ts。
            if (videos.isNotEmpty()) put("videos", kotlinx.serialization.json.JsonArray(videos))
        }
        return writeRequest("thread.${mode.method}", payload, mode.method)
    }

    suspend fun abort(): JsonElement? = writeRequest("thread.abort", buildJsonObject { }, "abort")

    /**
     * 按需取回附件字节，**直接写进目标文件**（视频原片不再随快照下发后的取字节入口）。
     *
     * 只读，**不需要写租约**（与 `stt.transcribe` 同类）：拉字节不该抢会话的编辑权。
     * 作用域校验在主机侧：附件必须被这个会话引用过，否则 NOT_FOUND。
     *
     * 服务端每片最多回几百 KB，由响应里的 `length`/`eof` 驱动循环（客户端不自己算分片边界）。
     * 直接落文件而不是先拼进内存：几十 MB 的视频不该在堆上过一遍。
     *
     * @param onProgress (已写字节, 总字节) —— 总字节首片之前为 0。
     * @return 写入的总字节数
     */
    suspend fun fetchAttachmentTo(name: String, target: File, onProgress: (Long, Long) -> Unit = { _, _ -> }): Long {
        // 名字由主机生成（uuid-原名），但仍守住底线：绝不能含路径成分。
        require(name.isNotEmpty() && name.none { it == '/' || it == '\\' }) { "非法附件名" }
        target.parentFile?.mkdirs()
        var offset = 0L
        var total = 0L
        var chunks = 0
        val sink = BufferedOutputStream(FileOutputStream(target))
        try {
            while (true) {
                if (chunks++ > MAX_ATTACHMENT_CHUNKS) throw IllegalStateException("附件分片数量异常")
                val payload = buildJsonObject {
                    put("name", name)
                    put("offset", offset)
                }
                val chunk = request("attachment.fetch", payload, threadId, ATTACHMENT_CHUNK_TIMEOUT_MS)
                    ?.jsonObject?.get("chunk")?.jsonObject
                    ?: throw IllegalStateException("附件响应格式不对")
                val data = chunk["data"]?.jsonPrimitive?.contentOrNull
                    ?: throw IllegalStateException("附件响应缺少数据")
                // 用 java.util.Base64（API 26+，本项目 minSdk=26）而不是 android.util.Base64：
                // 后者在 JVM 单测里是“not mocked”的 android.jar 存根，整条分片循环就没法单测了
                // （而它正是“视频播不播得出来”的全部逻辑）。
                val bytes = java.util.Base64.getDecoder().decode(data)
                chunk["size"]?.jsonPrimitive?.longOrNull?.let { if (it > 0) total = it }
                if (bytes.isNotEmpty()) {
                    sink.write(bytes)
                    offset += bytes.size
                    onProgress(offset, total)
                }
                if (chunk["eof"]?.jsonPrimitive?.booleanOrNull == true) return offset
                // 防护：主机若一直回空片且不置 eof，循环会一直请求下去（与 PWA 同一护栏）。
                if (bytes.isEmpty()) throw IllegalStateException("附件分片无进展")
            }
        } finally {
            runCatching { sink.close() }
        }
    }

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

        /** 单片附件的请求超时（几百 KB，弱网下别用默认超时误杀）。 */
        const val ATTACHMENT_CHUNK_TIMEOUT_MS = 30_000L

        /** 分片循环的硬上限（防死循环护栏）。512KB × 4096 片 = 2GB，正常永远走不到。 */
        const val MAX_ATTACHMENT_CHUNKS = 4096
    }
}
