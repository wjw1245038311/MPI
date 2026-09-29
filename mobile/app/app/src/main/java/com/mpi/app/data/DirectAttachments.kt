package com.mpi.app.data

import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * 附件**直连**（P2 安卓端）——与 PWA 的 `lib/attachment-direct.ts` 同一套协议。
 *
 * 为什么要有这条路：安卓端此前把整个视频 base64 塞进 `thread.prompt` 那一帧，被主机
 * 8MB 内层信封卡到 6MB（`MAX_FILE_BYTES`），于是「手机发大视频」根本发不出去。
 * 直连之后：上行按 4MB 分片 `PUT` 到主机附件区（上限 128MB），消息里只带 `storedName`；
 * 下行拿一个可直接喂给 ExoPlayer 的 URL（原生 Range，可拖进度条）。
 *
 * **回落是一等公民**：直连依赖 Tailscale 可达 + 主机开了附件服务 + 主机在线。任何一步不成立
 * 都要能退回老路（内联 / 中继分片），所以这里所有失败都通过返回值表达（null / false），
 * 不抛给 UI；只有协程取消会照常向上抛。
 */
/** 单次 PUT 的分片字节数。与主机 `ATTACHMENT_UPLOAD_CHUNK_BYTES`、PWA 同值。 */
const val DIRECT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024

/** 申请令牌的超时（与 PWA 的 `attachUrl` 请求同量级）。 */
const val DIRECT_REQUEST_TIMEOUT_MS = 20_000L

/** 单片上传的超时（4MB 在弱网下可能慢，比默认 10s 宽）。 */
private const val DIRECT_CHUNK_TIMEOUT_MS = 60_000L

/** 主机签发的直连目标（`attachment.url` 的回包）。 */
data class DirectTarget(
    val url: String,
    val token: String,
    /** 写：主机预分配的附件名（消息里只带它）；读：附件名。 */
    val name: String,
    val expiresAt: Long,
)

/**
 * 分片边界：`(offset, endInclusive)` 列表，覆盖 `[0, total)`。
 *
 * 纯函数，单测覆盖——边界写错的表现是「传到 99% 卡住」或最后一片被主机拒，很难现场归因。
 */
internal fun directChunkBounds(total: Long, chunk: Int = DIRECT_UPLOAD_CHUNK_BYTES): List<Pair<Long, Long>> {
    if (total <= 0) return emptyList()
    val size = chunk.coerceAtLeast(1).toLong()
    val out = ArrayList<Pair<Long, Long>>(((total + size - 1) / size).toInt())
    var offset = 0L
    while (offset < total) {
        val end = minOf(offset + size, total) - 1
        out += offset to end
        offset = end + 1
    }
    return out
}

/** 与主机 `parseUploadOffset` 对齐的声明格式（标准 Range 形式，总长必带）。 */
internal fun contentRangeHeader(offset: Long, endInclusive: Long, total: Long): String =
    "bytes $offset-$endInclusive/$total"

/** 主机回包 → [DirectTarget]；形状不对一律 null（调用方走回落）。 */
internal fun parseDirectTarget(payload: JsonElement?): DirectTarget? {
    val direct = runCatching { payload?.jsonObject?.get("direct")?.jsonObject }.getOrNull() ?: return null
    val url = runCatching { direct["url"]?.jsonPrimitive?.contentOrNull }.getOrNull()
    val name = runCatching { direct["name"]?.jsonPrimitive?.contentOrNull }.getOrNull()
    if (url.isNullOrEmpty() || name.isNullOrEmpty()) return null
    return DirectTarget(
        url = url,
        token = runCatching { direct["token"]?.jsonPrimitive?.contentOrNull }.getOrNull() ?: "",
        name = name,
        expiresAt = runCatching { direct["expiresAt"]?.jsonPrimitive?.longOrNull }.getOrNull() ?: 0L,
    )
}

/**
 * 直连客户端：申请令牌 → 分片 PUT → 送封面 / 换取读 URL。
 *
 * @param request 与 [ThreadActions] 同一条请求通道（`Requester.request`）。
 * @param http 可注入（单测替换 / 复用连接池）。
 */
class DirectAttachments(
    private val request: suspend (type: String, payload: JsonElement?, threadId: String?, timeoutMs: Long?) -> JsonElement?,
    private val http: OkHttpClient = defaultHttpClient(),
) {
    /**
     * 申请直连 URL。直连不可用（主机回 `DIRECT_UNAVAILABLE` / 不可达 / 超时）→ null。
     *
     * 其余错误（作用域不符、令牌形状异常）也按 null 处理：调用方总能走回落，不该为此弹错误。
     */
    suspend fun requestTarget(
        threadId: String,
        mode: String,
        name: String? = null,
        originalName: String? = null,
        mimeType: String? = null,
        size: Long? = null,
    ): DirectTarget? {
        val payload = buildJsonObject {
            put("mode", mode)
            name?.let { put("name", it) }
            originalName?.let { put("originalName", it) }
            mimeType?.let { put("mimeType", it) }
            size?.let { put("size", it) }
        }
        return try {
            parseDirectTarget(request("attachment.url", payload, threadId, DIRECT_REQUEST_TIMEOUT_MS))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
    }

    /**
     * 上传一个视频（直连）：分片 PUT **流式读源**（不在内存里囤整段）+ 送首帧封面。
     *
     * @param open 每次调用返回一个**新的**输入流（分片循环只开一次，失败即整体失败）。
     * @return 主机侧的附件名（消息里只带它）；任何一步失败 → null，调用方走内联回落。
     */
    suspend fun uploadVideo(
        threadId: String,
        originalName: String,
        mimeType: String,
        size: Long,
        open: () -> InputStream,
        posterB64: String? = null,
        onProgress: (Long, Long) -> Unit = { _, _ -> },
    ): String? {
        if (size <= 0L) return null
        val target = requestTarget(
            threadId = threadId,
            mode = "write",
            originalName = originalName,
            mimeType = mimeType,
            size = size,
        ) ?: return null

        try {
            open().use { input ->
                for ((start, end) in directChunkBounds(size)) {
                    val length = (end - start + 1).toInt()
                    val buffer = ByteArray(length)
                    var read = 0
                    while (read < length) {
                        val n = input.read(buffer, read, length - read)
                        // 源流提前结束（文件被改/读失败）→ 收不齐，直接放弃这次直连上传
                        if (n <= 0) return null
                        read += n
                    }
                    if (!putChunk(target.url, buffer, start, end, size)) return null
                    onProgress(end + 1, size)
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return null
        }

        // 封面是观感优化：送失败不算上传失败（消息里还会再带一份，主机侧幂等）。
        if (posterB64 != null) {
            runCatching { postPoster(target.url, posterB64) }
        }
        return target.name
    }

    /** 换一个可直接喂给播放器的读 URL（原生 Range / 可 seek）。不可用 → null。 */
    suspend fun playbackUrl(threadId: String, name: String, mimeType: String?): String? =
        requestTarget(threadId = threadId, mode = "read", name = name, mimeType = mimeType)?.url

    private suspend fun putChunk(url: String, bytes: ByteArray, offset: Long, end: Long, total: Long): Boolean =
        withContext(Dispatchers.IO) {
            val httpRequest = Request.Builder()
                .url(url)
                .put(bytes.toRequestBody(OCTET_STREAM))
                .header("Content-Range", contentRangeHeader(offset, end, total))
                .build()
            val call = http.newCall(httpRequest)
            // 协程被取消（用户点「取消上传」/离开会话）→ 立刻掐断在途的请求，
            // 否则那 4MB 会一直传到超时为止。
            val handle = coroutineContext[Job]?.invokeOnCompletion { call.cancel() }
            try {
                call.execute().use { it.isSuccessful }
            } catch (_: Exception) {
                false
            } finally {
                handle?.dispose()
            }
        }

    private suspend fun postPoster(url: String, posterB64: String): Boolean = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("poster", posterB64)
            put("posterMimeType", "image/jpeg")
        }.toString().toRequestBody(JSON)
        val call = http.newCall(Request.Builder().url(url).post(body).build())
        val handle = coroutineContext[Job]?.invokeOnCompletion { call.cancel() }
        try {
            call.execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        } finally {
            handle?.dispose()
        }
    }

    companion object {
        private val OCTET_STREAM = "application/octet-stream".toMediaType()
        private val JSON = "application/json".toMediaType()

        private fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(DIRECT_CHUNK_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .writeTimeout(DIRECT_CHUNK_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build()
    }
}
