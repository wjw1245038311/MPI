package com.mpi.app.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * 待发送的附件（已压缩 + base64）—— M4 原生能力第一项，对齐 PWA `lib/image-attach.ts`
 * 与 `ThreadActions.send(text, mode, images, files)`。
 *
 * 主机端（`src/main/remote/service.ts`）的硬约束：
 * - 图片：最多 3 张；单张 base64 ≤ 1,200,000 字符；合计 ≤ 1,500,000；
 *   MIME 必须是 jpeg / png / webp / gif；
 * - 文件：最多 3 个；单个 base64 ≤ 8,000,000（约 6MB 原文件）；合计 ≤ 16,000,000；
 *   名字 ≤ 180 字符。
 *
 * 所以图片一律在手机上先降采样 + JPEG 质量循环压到 [MAX_RAW_BYTES] 以内再编码。
 */
sealed interface Attachment {
    /** 图片（已转 JPEG）。 */
    data class Image(val bytesB64: String, val mimeType: String) : Attachment

    /**
     * 任意文件（原样 base64）。
     *
     * 视频会多带一张**首帧封面**（`posterB64`）：主机把它落盘并把快照里的画面换成它，
     * 视频本体由各端**点开时按需拉**（见主机 remote/video-refs.ts 与 attachment.fetch）。
     * 抽帧失败时保持 null（接收端退化成深色卡片，不影响可播性）。
     */
    data class File(
        val name: String,
        val mimeType: String?,
        val bytesB64: String,
        val posterB64: String? = null,
    ) : Attachment

    /**
     * 已**直连上传**到主机附件区的视频（P2）：消息里只带 `storedName`，零字节。
     *
     * 与 [File] 分开的原因：File 走内联（受 6MB 限制、字节要进那一帧），Video 的字节早就
     * 在主机磁盘上了；两者的上限、失败处置与回落路径都不同（见 AppViewModel.addVideoAttachment）。
     */
    data class Video(
        /** 主机侧附件名（写令牌预分配，形如 `uuid-原名`）。 */
        val storedName: String,
        val originalName: String,
        val mimeType: String,
        val size: Long,
        /** 首帧封面（base64 JPEG）；抽不到就是深色卡片。 */
        val posterB64: String? = null,
    ) : Attachment

    /**
     * 已经**降落到主机工作区**的文件（P3-S2，>6MB 的文件走这条）：
     * 主机把它放进了 `<会话 cwd>/mpi-inbox/`，消息里带绝对路径，agent 直接就能读。
     *
     * 为什么不用 [File] 内联：内联受 8MB 信封限制（实际上限 6MB），大文件根本发不出去。
     */
    data class WorkspaceFile(
        /** 可读文件名（主机侧同名/加后缀后的名字）。 */
        val name: String,
        /** 主机上的绝对路径（写进 prompt 的 `<file path="…">`）。 */
        val path: String,
        val size: Long,
    ) : Attachment
}

/** 文件元信息（不读字节）。 */
data class FileMeta(val name: String, val mimeType: String?, val size: Long)

/** 直连上传需要的视频元信息（**不读字节**，字节由 [VideoSource.open] 流式读）。 */
data class VideoSource(
    val name: String,
    val mimeType: String,
    val size: Long,
    /** 每次调用返回一个新的输入流（分片循环流式读，几十 MB 不进内存）。 */
    val open: () -> java.io.InputStream,
    val posterB64: String?,
)

// ---- 图片压缩（与 PWA 同一口径）----

const val MAX_EDGE = 1280

/** 压缩后的**原始字节**上限：base64 膨胀约 33% → ≈373k，远小于主机单张上限。 */
const val MAX_RAW_BYTES = 280 * 1024

private const val MIN_QUALITY = 0.5
private const val START_QUALITY = 0.8

/** 文件的原始字节上限（对应主机 8MB base64 上限）。 */
const val MAX_FILE_BYTES = 6_000_000L

/** 封面的最长边（px）。与 PWA / 桌面端同一口径（气泡卡片约 300dp 宽）。 */
const val POSTER_MAX_EDGE = 640

/** 封面的原始字节上限，与主机侧 video-refs.ts 的 VIDEO_POSTER_MAX_BYTES 一致。 */
const val POSTER_MAX_BYTES = 160_000

/** 视频文件扩展名（与主机 isVideoFile 同一集合）。 */
private val VIDEO_EXTENSIONS = setOf("mp4", "m4v", "webm", "mov", "mkv", "avi")

/** 按 MIME/文件名判断是不是视频（决定要不要抽封面）。 */
internal fun looksLikeVideo(name: String?, mimeType: String?): Boolean {
    if (mimeType?.startsWith("video/") == true) return true
    val ext = name?.substringAfterLast('.', "")?.lowercase() ?: ""
    return ext in VIDEO_EXTENSIONS
}

/**
 * 文件名 → `video/` 前缀的 mime（`contentResolver.getType` 常给不出 mime 时的兜底）。
 *
 * 与主机 `attachment-server.ts` 的 MIME 表同一口径：mime 不对时主机把附件当
 * `application/octet-stream` 下发，播放器照样能播，但 `videos[]` 通道会直接拒（必须是视频类型）。
 */
internal fun mimeTypeFromName(name: String): String? =
    when (name.substringAfterLast('.', "").lowercase()) {
        "mp4" -> "video/mp4"
        "m4v" -> "video/x-m4v"
        "webm" -> "video/webm"
        "mov" -> "video/quicktime"
        "mkv" -> "video/x-matroska"
        "avi" -> "video/x-msvideo"
        else -> null
    }

/**
 * 质量循环的一步：是否已够小，以及下一步的 quality（纯函数，可单测）。
 */
internal fun nextQuality(rawBytes: Int, quality: Double): Pair<Boolean, Double> {
    if (rawBytes <= MAX_RAW_BYTES || quality <= MIN_QUALITY) return true to quality
    return false to (Math.round((quality - 0.1) * 100) / 100.0)
}

/** 解码 → 缩放（最长边 ≤ [MAX_EDGE]）→ JPEG 质量循环。失败返回 null。 */
internal fun compressToJpeg(bytes: ByteArray): ByteArray? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    val scale = min(1.0, MAX_EDGE.toDouble() / max(bounds.outWidth, bounds.outHeight))
    val targetW = max(1, (bounds.outWidth * scale).roundToInt())
    val targetH = max(1, (bounds.outHeight * scale).roundToInt())

    val opts = BitmapFactory.Options().apply {
        inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, targetW, targetH)
    }
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null

    val scaled = if (decoded.width != targetW || decoded.height != targetH) {
        Bitmap.createScaledBitmap(decoded, targetW, targetH, true)
    } else {
        decoded
    }

    var quality = START_QUALITY
    var out = ByteArray(0)
    while (true) {
        val stream = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, (quality * 100).roundToInt(), stream)
        out = stream.toByteArray()
        val step = nextQuality(out.size, quality)
        if (step.first) break
        quality = step.second
    }

    if (scaled !== decoded) scaled.recycle()
    decoded.recycle()
    return out
}

/** 2 的幂次采样率，让解码后的边长仍不小于目标边长。 */
internal fun sampleSize(srcW: Int, srcH: Int, targetW: Int, targetH: Int): Int {
    var sample = 1
    var w = srcW
    var h = srcH
    while (w / 2 >= targetW && h / 2 >= targetH) {
        w /= 2
        h /= 2
        sample *= 2
    }
    return sample
}

/**
 * 从系统选择器拿到的 URI 读出附件。
 *
 * 失败一律走 [Result]（带着可读文案）——不静默失败：调用方把 message 显示给用户。
 */
class AttachmentLoader(private val context: Context) {

    fun loadImage(uri: Uri): Result<Attachment.Image> = runCatching {
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            ?: error("无法读取这张图片")
        val jpeg = compressToJpeg(bytes) ?: error("这不是可识别的图片")
        Attachment.Image(Base64.encodeToString(jpeg, Base64.NO_WRAP), "image/jpeg")
    }

    /**
     * 读一个视频的元信息（名字 / mime / 大小 / 封面），**不把字节读进内存**。
     *
     * 直连上行按 4MB 分片流式读，所以这里只给一个「开流」函数：128MB 的视频也不该在
     * 手机上先拼成一个大 ByteArray（那是 OOM 与卡顿的来源）。
     */
    fun loadVideoSource(uri: Uri): Result<VideoSource> = runCatching {
        val size = context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L
        if (size <= 0L) error("这个视频读不出大小（可能不是本地文件）")
        val name = (displayName(uri) ?: "视频").take(180)
        val mimeType = context.contentResolver.getType(uri)
            ?: mimeTypeFromName(name)
            ?: "video/mp4"
        VideoSource(
            name = name,
            mimeType = if (mimeType.startsWith("video/")) mimeType else "video/mp4",
            size = size,
            open = { context.contentResolver.openInputStream(uri) ?: error("无法读取这个视频") },
            posterB64 = videoPosterB64(uri),
        )
    }

    fun loadFile(uri: Uri): Result<Attachment.File> = runCatching {
        val meta = fileMeta(uri) ?: error("无法读取这个文件")
        if (meta.size > MAX_FILE_BYTES) error("文件太大（上限 6MB）")
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            ?: error("无法读取这个文件")
        if (bytes.size > MAX_FILE_BYTES) error("文件太大（上限 6MB）")
        Attachment.File(
            name = meta.name,
            mimeType = meta.mimeType,
            bytesB64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
            // 视频：顺手拍一张首帧当封面（抽不出来就 null，不算失败）。
            posterB64 = if (looksLikeVideo(meta.name, meta.mimeType)) videoPosterB64(uri) else null,
        )
    }

    /** 每次调用返回一个**新的**输入流（直连分片上传是流式读源，多个 worker 不能共用一条流）。 */
    fun openStream(uri: Uri): java.io.InputStream =
        context.contentResolver.openInputStream(uri) ?: error("无法读取这个文件")

    /** 只读元信息（不读字节）：大文件走直连时需要先知道大小与名字。 */
    fun fileMeta(uri: Uri): FileMeta? = runCatching {
        val size = context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L
        FileMeta(
            name = displayName(uri)?.take(180) ?: "附件",
            mimeType = context.contentResolver.getType(uri),
            size = if (size > 0) size else -1L,
        )
    }.getOrNull()

    /**
     * 抽视频首帧并压成 ≤ POSTER_MAX_BYTES 的 JPEG（base64）。
     *
     * 用 MediaMetadataRetriever（同一套已经用在"抽首帧当封面"的显示路径上），失败返回 null。
     */
    private fun videoPosterB64(uri: Uri): String? = runCatching {
        val retriever = android.media.MediaMetadataRetriever()
        try {
            retriever.setDataSource(context, uri)
            // 0.1s 而不是 0：有些编码在 t=0 只给黑帧（与两端 `#t=0.1` 促帧同理）。
            val frame = retriever.getFrameAtTime(100_000) ?: retriever.getFrameAtTime(0) ?: return null
            val jpeg = frameToJpeg(frame)
            jpeg?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
        } finally {
            runCatching { retriever.release() }
        }
    }.getOrNull()

    /** 缩放到最长边 ≤ POSTER_MAX_EDGE 后压 JPEG，质量循环到字节上限内。 */
    private fun frameToJpeg(frame: Bitmap): ByteArray? {
        val scale = min(1.0, POSTER_MAX_EDGE.toDouble() / max(frame.width, frame.height).toDouble())
        val width = max(1, (frame.width * scale).roundToInt())
        val height = max(1, (frame.height * scale).roundToInt())
        val scaled = if (width == frame.width && height == frame.height) frame else Bitmap.createScaledBitmap(frame, width, height, true)
        var quality = 72
        var bytes = encodeJpeg(scaled, quality)
        while (bytes != null && bytes.size > POSTER_MAX_BYTES && quality > 50) {
            quality -= 10
            bytes = encodeJpeg(scaled, quality)
        }
        if (scaled !== frame) scaled.recycle()
        return bytes?.takeIf { it.size <= POSTER_MAX_BYTES }
    }

    private fun encodeJpeg(bitmap: Bitmap, quality: Int): ByteArray? = runCatching {
        ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            out.toByteArray()
        }
    }.getOrNull()

    private fun displayName(uri: Uri): String? = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
            }
    }.getOrNull()
}
