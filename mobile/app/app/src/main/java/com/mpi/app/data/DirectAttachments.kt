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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.booleanOrNull
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
    /** 写：主机预分配的附件名（消息里只带它）；读：附件名。内容寻址后**就是内容 key**。 */
    val name: String,
    val expiresAt: Long,
    /** 主机声明本次载荷必须加密（`v1`）——客户端据此带 `X-MPI-Enc` 头，见 [AttachmentCrypto]。 */
    val enc: String? = null,
    /** `sha256:<hex>`（内容寻址后才有；老主机没有这个字段）。 */
    val key: String? = null,
    /** 可读的原文件名（`name` 是 64 位哈希时，界面展示靠它）。 */
    val label: String? = null,
    /** 内容去重命中：字节已在主机 → **不要上传**，直接用 [name]。老主机没有这个字段（= null）。 */
    val deduped: Boolean? = null,
    /**
     * 「降落到工作区」（P3-S2）命中去重时才由 mint 直接回报的路径：
     * 内容已在库 → 主机不需要收字节，已经在 mint 阶段就把文件放进了 `mpi-inbox/`。
     */
    val workspacePath: String? = null,
    val workspaceName: String? = null,
)

/** 一次媒体上传的结果（P3：图/音/视/文件共用一套通道）。 */
data class MediaUpload(
    /** 主机侧的名字：内容寻址后就是内容 key。 */
    val name: String,
    /** 内容已在主机（零字节上传）。 */
    val deduped: Boolean,
    /** 「降落到工作区」后的绝对路径（agent 用它读文件）；未请求或主机不支持时为 null。 */
    val workspacePath: String? = null,
    val workspaceName: String? = null,
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
    // name 为空时只有在「去重命中」时才是合法的（那时主机不回 url，只回 key/name）。
    val deduped = runCatching { direct["deduped"]?.jsonPrimitive?.booleanOrNull }.getOrNull()
    if (name.isNullOrEmpty()) return null
    if (url.isNullOrEmpty() && deduped != true) return null
    return DirectTarget(
        url = url.orEmpty(),
        token = runCatching { direct["token"]?.jsonPrimitive?.contentOrNull }.getOrNull() ?: "",
        name = name,
        expiresAt = runCatching { direct["expiresAt"]?.jsonPrimitive?.longOrNull }.getOrNull() ?: 0L,
        enc = runCatching { direct["enc"]?.jsonPrimitive?.contentOrNull }.getOrNull(),
        key = runCatching { direct["key"]?.jsonPrimitive?.contentOrNull }.getOrNull(),
        label = runCatching { direct["label"]?.jsonPrimitive?.contentOrNull }.getOrNull(),
        deduped = deduped,
        workspacePath = runCatching { direct["workspacePath"]?.jsonPrimitive?.contentOrNull }.getOrNull(),
        workspaceName = runCatching { direct["workspaceName"]?.jsonPrimitive?.contentOrNull }.getOrNull(),
    )
}

/**
 * 流式计算 SHA-256（1MB 一块，128MB 不整读进内存）——内容寻址的 key 就来自它。
 *
 * 读不出来（IO 异常）→ null，调用方据此报「无法读取视频」而不是默默上传一份算不出 key 的字节。
 */
internal fun sha256OfStream(open: () -> InputStream): String? = runCatching {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(1024 * 1024)
    open().use { input ->
        while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            digest.update(buffer, 0, read)
        }
    }
    digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}.getOrNull()

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
        /** 内容寻址（P1）：整文件 SHA-256（小写 hex）。写方向才带，主机据此去重与校验。 */
        sha256: String? = null,
        /** 「降落到工作区」（P3-S2）：写方向才带。主机把文件放进 <会话 cwd>/mpi-inbox/。 */
        workspace: Boolean = false,
    ): DirectTarget? {
        val payload = buildJsonObject {
            put("mode", mode)
            name?.let { put("name", it) }
            originalName?.let { put("originalName", it) }
            mimeType?.let { put("mimeType", it) }
            size?.let { put("size", it) }
            sha256?.let { put("sha256", it) }
            if (workspace && mode == "write") put("workspace", true)
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
        // 先算整文件 SHA-256（内容 key）：
        //   ① 主机已有同一内容 → mint 回 deduped，**一个字节都不用传**（重发同一个视频秒完成）；
        //   ② 否则主机收齐后会自己再算一遍比对，不符就拒——落盘错位/链路损坏会当场暴露
        //      （2026-09-29 的「不能看」事故就是缺了这一步）。
        // 代价是多读一遍文件（128MB 本地读 1–2s），换来去重与损坏必拒。
        val contentHash = sha256OfStream(open)
            ?: throw DirectUploadException("无法读取视频以计算校验值（文件被移动或权限不足？）")
        val target = requestTarget(
            threadId = threadId,
            mode = "write",
            originalName = originalName,
            mimeType = mimeType,
            size = size,
            sha256 = contentHash,
        ) ?: return null

        // 去重命中：字节已在主机（可能是别的会话、甚至别的设备上传的同一份内容）→ 直接交名下。
        // 封面也不用重传：主机上的那个对象本来就有封面（首次上传时落的）。
        if (target.deduped == true) return target.name

        // 分片上传 + 末片屏障（与图/音/文件共用同一套实现）。
        val outcome = putAllChunks(target, size, open, sessionKey, onProgress)
        if (outcome.problem != null) throw DirectUploadException(outcome.problem)

        // 封面是观感优化：送失败不算上传失败（消息里还会再带一份，主机侧幂等）。
        if (posterB64 != null) {
            runCatching { postPoster(target.url, posterB64) }
        }
        return target.name
    }

    /**
     * 上传一段**媒体字节**（P3：图/音/视/文件共用一套通道）。
     *
     * 与 [uploadVideo] 的区别只有两处：① 不需要首帧封面；② 可以请求「降落到工作区」
     * （`workspace=true` → 主机把文件放进 `<会话 cwd>/mpi-inbox/` 并回报绝对路径）。
     *
     * @param workspace 大文件给 agent 读时用：拿回来的 [MediaUpload.workspacePath] 直接写进
     *   prompt 的 `<file path="…">`。
     * @return null 表示直连不可用（调用方走内联/给能归因的错误）。
     */
    suspend fun uploadMedia(
        threadId: String,
        originalName: String,
        mimeType: String,
        size: Long,
        open: () -> InputStream,
        sessionKey: ByteArray? = null,
        workspace: Boolean = false,
        onProgress: (Long, Long) -> Unit = { _, _ -> },
    ): MediaUpload? {
        if (size <= 0L) return null
        val contentHash = sha256OfStream(open)
            ?: throw DirectUploadException("无法读取文件以计算校验值（文件被移动或权限不足？）")
        val target = requestTarget(
            threadId = threadId,
            mode = "write",
            originalName = originalName,
            mimeType = mimeType,
            size = size,
            sha256 = contentHash,
            workspace = workspace,
        ) ?: return null
        // 去重命中：字节已在主机。请求了工作区时不等于“什么都不做”——主机在 mint 阶段
        // 就已经把文件放进 mpi-inbox 并把路径回给你了（见 ipc.ts 的 deduped 分支）。
        if (target.deduped == true) {
            return MediaUpload(target.name, deduped = true, target.workspacePath, target.workspaceName)
        }
        val outcome = putAllChunks(target, size, open, sessionKey, onProgress)
        if (outcome.problem != null) throw DirectUploadException(outcome.problem)
        return MediaUpload(
            name = target.name,
            deduped = false,
            workspacePath = outcome.workspacePath,
            workspaceName = outcome.workspaceName,
        )
    }

    /**
     * 分片上传全量：生产者顺序读源 + N 片并发 PUT + 末片屏障。
     *
     * 抽出来是因为媒体（P3）与视频走的是同一套并发/屏障/加密语义——复制一份就等于以后
     * 修一处忘一处（那次「a+ 追加导致落盘错位」的教训还包括「两处实现很容易漂移」）。
     */
    private suspend fun putAllChunks(
        target: DirectTarget,
        size: Long,
        open: () -> InputStream,
        sessionKey: ByteArray?,
        onProgress: (Long, Long) -> Unit,
    ): PutOutcome {
        val plan = directUploadPlan(size)
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
                                    if (n <= 0) throw DirectUploadException("读取文件中断（已读 ${offset + read} / $size 字节）")
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
                            val outcome = putChunk(target.url, pending.bytes, pending.offset, pending.end, size, enc)
                            if (outcome.problem != null) throw DirectUploadException(outcome.problem)
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
            throw error
        } catch (_: Exception) {
            throw DirectUploadException("上传失败（网络中断或主机不可达）")
        }
        val last = lastBytes ?: return PutOutcome(null, null, null)
        val outcome = putChunk(target.url, last, plan.last!!.first, plan.last.second, size, enc)
        if (outcome.problem == null) onProgress(sent.addAndGet(last.size.toLong()), size)
        return outcome
    }

    /** 一次分片 PUT 的结果：problem 非空 = 失败；body 是成功时的主机回执（末片要看工作区路径）。 */
    internal class PutOutcome(val problem: String?, val body: String?, private val workspace: String? = null) {
        /** 「降落到工作区」后的绝对路径（主机在末片回执里给的）。 */
        val workspacePath: String? get() = workspace ?: null
        val workspaceName: String? get() = workspacePath?.substringAfterLast('\\')?.substringAfterLast('/')
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
    ): PutOutcome =
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
                        // 回执里可能带 workspacePath（「降落到工作区」）；解析失败不影响上传成功。
                        val text = runCatching { response.body?.string() }.getOrNull()
                        PutOutcome(null, text, text?.let(::parseWorkspacePath))
                    } else {
                        // 状态码 + 响应体片段带回界面：403/404 是令牌与作用域的事，
                        // 连接超时/握手失败是网络的事——没这句就只能看到「0% 不动」。
                        val body = runCatching { response.body?.string()?.take(120) }.getOrNull().orEmpty()
                        PutOutcome("分片上传被拒：HTTP ${response.code} $body", null)
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                PutOutcome("分片上传失败：${error.javaClass.simpleName} ${error.message.orEmpty().take(80)}", null)
            } finally {
                handle?.dispose()
            }
        }

    /** 从末片回执里取 `workspacePath`（没有/解析不了 → null）。 */
    private fun parseWorkspacePath(body: String): String? = runCatching {
        Json.parseToJsonElement(body).jsonObject["workspacePath"]?.jsonPrimitive?.contentOrNull
    }.getOrNull()

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
