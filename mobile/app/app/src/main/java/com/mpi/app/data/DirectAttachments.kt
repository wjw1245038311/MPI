package com.mpi.app.data

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
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

/**
 * 同时在途的分片数。
 *
 * 为什么要并发：单片 4MB、串行发，吞吐被「单连接 / RTT」卡死——手机走 Tailscale 中继时
 * 实测 RTT 58–350ms（有时近 1s），串行只能到 1.1MB/s。3 片在途把这条链路的吞吐拉回数倍，
 * 代价只是内存里同时驻留几片（≤ 12MB），不上传完不入盘。
 */
const val DIRECT_UPLOAD_CONCURRENCY = 3

/**
 * 上传计划：中间分片可**并发**发，最后一片必须**等其它全部成功之后再发**。
 *
 * 为什么最后一片要单独拿出来（客户端屏障）：主机的收齐判定是
 * `received = max(offset+len)`（临时文件的大小），并不记「哪些区间到了」。乱序并发下，
 * 若最高偏移那片提前到达，主机就会**误判收齐并定稿**，剩下的片写进已改名的成品之外。
 * 把最后一片当屏障，收齐这件事就由客户端保证——不用改主机、PWA 也能照用。
 */
internal data class UploadPlan(val parallel: List<Pair<Long, Long>>, val last: Pair<Long, Long>?)

internal fun directUploadPlan(total: Long, chunk: Int = DIRECT_UPLOAD_CHUNK_BYTES): UploadPlan {
    val bounds = directChunkBounds(total, chunk)
    if (bounds.isEmpty()) return UploadPlan(emptyList(), null)
    return UploadPlan(bounds.dropLast(1), bounds.last())
}

/** 从 `Content-Range: bytes 0-1023/4096` 里取总长度（取不到 → 0）。 */
internal fun parseRangeTotal(contentRange: String?): Long {
    val value = contentRange ?: return 0L
    return value.substringAfterLast('/', "").trim().toLongOrNull() ?: 0L
}

/** 直连上传失败（带原因，供界面如实告知）。 */
class DirectUploadException(message: String) : Exception(message)

/** 主机签发的直连目标（`attachment.url` 的回包）。 */
data class DirectTarget(
    val url: String,
    val token: String,
    /** 写：主机预分配的附件名（消息里只带它）；读：附件名。 */
    val name: String,
    val expiresAt: Long,
    /** 主机声明本次载荷必须加密（`v1`）——客户端据此带 `X-MPI-Enc` 头，见 [AttachmentCrypto]。 */
    val enc: String? = null,
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
        enc = runCatching { direct["enc"]?.jsonPrimitive?.contentOrNull }.getOrNull(),
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
     * 读源是**顺序**的、发送是**并发**的：单条输入流不能多线程读，所以由一个生产者顺序
     * 读出分片、交给 [DIRECT_UPLOAD_CONCURRENCY] 个 worker 并行 PUT（队列做背压，
     * 内存里同时最多几片）；最后一片走客户端屏障（见 [directUploadPlan]）。
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
        /** E2E 会话密钥（配对时协商、从不过网）；主机声明需要加密时必填。 */
        sessionKey: ByteArray? = null,
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

        val plan = directUploadPlan(size)
        // 主机说“要加密”（v1）就派生本方向的密钥；拿不到会话密钥时**必须失败**，
        // 不能默默传明文（那样用户以为加密了，实际把视频交给了链路上的任何人）。
        val enc = if (target.enc == AttachmentCrypto.VERSION) {
            val key = sessionKey ?: throw DirectUploadException("主机要求加密，但本机没有 E2E 会话密钥（重新配对后再试）")
            EncContext(
                key = AttachmentCrypto.deriveKey(key, target.token, AttachmentCrypto.UP, target.name),
                token = target.token,
                name = target.name,
            )
        } else {
            null
        }
        val sent = AtomicLong(0)
        var lastBytes: ByteArray? = null

        try {
            coroutineScope {
                val queue = Channel<PendingChunk>(capacity = DIRECT_UPLOAD_CONCURRENCY)
                // 生产者：顺序读源 → 入队（队列满时自动背压）；最后一片不排队，留在手上等屏障。
                //
                // 失败传播：worker 一失败就**抛异常**（而不是 break 退出），这样 producer 的
                // send() 会被取消、join() 不会永远阻塞。（旧写法只 break → 队列无人接收时
                // producer 永久卡在 send()：表现就是进度永远 0% 且连错误都不弹。）
                val producer = launch {
                    // 顺序依次读出全部片，但只把中间片入队；最后一片留在手上等屏障。
                    val order = plan.parallel + listOfNotNull(plan.last)
                    try {
                        open().use { input ->
                            for ((offset, end) in order) {
                                val length = (end - offset + 1).toInt()
                                val buffer = ByteArray(length)
                                var read = 0
                                while (read < length) {
                                    val n = input.read(buffer, read, length - read)
                                    // 源流提前结束（文件被改/读失败）→ 收不齐，直接放弃这次直连上传
                                    if (n <= 0) throw DirectUploadException("读取视频中断（已读 ${offset + read} / $size 字节）")
                                    read += n
                                }
                                if (end == plan.last?.second) lastBytes = buffer else queue.send(PendingChunk(offset, end, buffer))
                            }
                        }
                    } finally {
                        queue.close()
                    }
                }
                val workers = List(DIRECT_UPLOAD_CONCURRENCY) {
                    launch(Dispatchers.IO) {
                        for (pending in queue) {
                            val problem = putChunk(target.url, pending.bytes, pending.offset, pending.end, size, enc)
                            if (problem != null) throw DirectUploadException(problem)
                            onProgress(sent.addAndGet(pending.bytes.size.toLong()), size)
                        }
                    }
                }
                producer.join()
                workers.forEach { it.join() }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: DirectUploadException) {
            // 带上原因上抛：让界面能告知「为什么传不上去」（网络？令牌？）
            throw error
        } catch (_: Exception) {
            return null
        }

        // 屏障：中间分片全部 200 之后才发最后一片（它触发主机侧的收齐与定稿）。
        val last = lastBytes ?: return target.name
        val lastProblem = putChunk(target.url, last, plan.last!!.first, plan.last.second, size, enc)
        if (lastProblem != null) throw DirectUploadException(lastProblem)
        onProgress(sent.addAndGet(last.size.toLong()), size)

        // 封面是观感优化：送失败不算上传失败（消息里还会再带一份，主机侧幂等）。
        if (posterB64 != null) {
            runCatching { postPoster(target.url, posterB64) }
        }
        return target.name
    }

    /** 一片待发的分片（生产者在内存里拿着，worker 发出后即释放）。 */
    private class PendingChunk(val offset: Long, val end: Long, val bytes: ByteArray)

    /** 加密上下文：把 token/附件名/密钥打包，避免每处都传四个参数。 */
    private class EncContext(val key: ByteArray, val token: String, val name: String)

    /** 换一个可直接喂给播放器的读 URL（原生 Range / 可 seek）。不可用 → null。 */
    suspend fun playbackUrl(threadId: String, name: String, mimeType: String?): String? =
        requestTarget(threadId = threadId, mode = "read", name = name, mimeType = mimeType)?.url

    /**
     * **加密直连下载**：按 Range 取回加密分片 → 解密 → 追加写入本地文件。
     *
     * 为什么不把 URL 直接喂 ExoPlayer：载荷是密文，播放器解不了；解密必须由我们做。
     * 代价是「边下边播」变成「下完再播」（与中继分片那条路一致），换来的是**明文链路上内容也不外泄**。
     *
     * @return 是否成功（主机/网络/解密任一步失败即 false，调用方回落中继）
     */
    suspend fun downloadEncrypted(
        target: DirectTarget,
        sessionKey: ByteArray,
        output: File,
        chunkBytes: Int = 512 * 1024,
        onProgress: (Long, Long) -> Unit = { _, _ -> },
        /** 失败原因（给界面显示）——排查时没有它就只能看到「附件不可用」这种无信息量的提示。 */
        onError: (String) -> Unit = {},
    ): Boolean {
        if (target.enc != AttachmentCrypto.VERSION) {
            onError("主机未声明加密（enc=${target.enc}）")
            return false
        }
        val key = AttachmentCrypto.deriveKey(sessionKey, target.token, AttachmentCrypto.DOWN, target.name)
        output.parentFile?.mkdirs()
        var offset = 0L
        var total = 0L
        try {
            FileOutputStream(output).use { sink ->
                while (total == 0L || offset < total) {
                    val slice = fetchRangeSlice(target.url, offset, chunkBytes)
                    if (slice == null) {
                        onError("取片失败：offset=$offset（网络/令牌/主机不可达）")
                        return false
                    }
                    if (slice.total > 0L) total = slice.total
                    val plain = try {
                        AttachmentCrypto.decrypt(
                            key,
                            slice.body,
                            AttachmentCrypto.aad(AttachmentCrypto.DOWN, target.name, offset, slice.plainLength),
                        )
                    } catch (error: Exception) {
                        onError("解密失败：offset=$offset bodyLen=${slice.body.size} plain=${slice.plainLength} ${error.javaClass.simpleName} ${error.message.orEmpty().take(60)}")
                        return false
                    }
                    // 没进展就停：否则主机一直回空片会把这个循环转成死循环（与分片拉取同一护栏）。
                    if (plain.isEmpty()) {
                        onError("解密得到空片：offset=$offset")
                        return false
                    }
                    sink.write(plain)
                    offset += plain.size.toLong()
                    onProgress(offset, total)
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            onError("下载异常：${error.javaClass.simpleName} ${error.message.orEmpty().take(60)}")
            return false
        }
        return true
    }

    /** 取一片加密载荷（含解密所需元数据）。失败 → null。 */
    private suspend fun fetchRangeSlice(url: String, offset: Long, chunkBytes: Int): RangeSlice? =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(url)
                .header(AttachmentCrypto.HEADER, AttachmentCrypto.VERSION)
                .header("Range", "bytes=$offset-${offset + chunkBytes - 1}")
                .build()
            val call = http.newCall(request)
            val handle = coroutineContext[Job]?.invokeOnCompletion { call.cancel() }
            try {
                call.execute().use { response ->
                    val body = if (response.isSuccessful) response.body?.bytes() else null
                    if (body == null) {
                        null
                    } else {
                        RangeSlice(
                            body = body,
                            plainLength = response.header("X-MPI-Len")?.toIntOrNull() ?: (body.size - AttachmentCrypto.OVERHEAD),
                            total = parseRangeTotal(response.header("Content-Range")),
                        )
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            } finally {
                handle?.dispose()
            }
        }

    /** 一片加密载荷。 */
    private class RangeSlice(val body: ByteArray, val plainLength: Int, val total: Long)

    private suspend fun putChunk(
        url: String,
        bytes: ByteArray,
        offset: Long,
        end: Long,
        total: Long,
        enc: EncContext?,
    ): String? =
        withContext(Dispatchers.IO) {
            val plainLength = bytes.size
            val body = if (enc == null) {
                bytes.toRequestBody(OCTET_STREAM)
            } else {
                AttachmentCrypto.encrypt(enc.key, bytes, AttachmentCrypto.aad(AttachmentCrypto.UP, enc.name, offset, plainLength))
                    .toRequestBody(OCTET_STREAM)
            }
            val builder = Request.Builder()
                .url(url)
                .put(body)
                .header("Content-Range", contentRangeHeader(offset, end, total))
            if (enc != null) builder.header(AttachmentCrypto.HEADER, AttachmentCrypto.VERSION)
            val httpRequest = builder.build()
            val call = http.newCall(httpRequest)
            // 协程被取消（用户点「取消上传」/离开会话）→ 立刻掐断在途的请求，
            // 否则那 4MB 会一直传到超时为止。
            val handle = coroutineContext[Job]?.invokeOnCompletion { call.cancel() }
            try {
                call.execute().use { response ->
                    if (response.isSuccessful) {
                        null
                    } else {
                        // 状态码 + 响应体片段带回界面：403/404 是令牌与作用域的事，
                        // 连接超时/握手失败是网络的事——没这句就只能看到「0% 不动」。
                        val body = runCatching { response.body?.string()?.take(120) }.getOrNull().orEmpty()
                        "分片上传被拒：HTTP ${response.code} $body"
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                "分片上传失败：${error.javaClass.simpleName} ${error.message.orEmpty().take(80)}"
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
