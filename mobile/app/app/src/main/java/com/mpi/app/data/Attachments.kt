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

    /** 任意文件（原样 base64）。 */
    data class File(val name: String, val mimeType: String?, val bytesB64: String) : Attachment
}

// ---- 图片压缩（与 PWA 同一口径）----

const val MAX_EDGE = 1280

/** 压缩后的**原始字节**上限：base64 膨胀约 33% → ≈373k，远小于主机单张上限。 */
const val MAX_RAW_BYTES = 280 * 1024

private const val MIN_QUALITY = 0.5
private const val START_QUALITY = 0.8

/** 文件的原始字节上限（对应主机 8MB base64 上限）。 */
const val MAX_FILE_BYTES = 6_000_000L

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

    fun loadFile(uri: Uri): Result<Attachment.File> = runCatching {
        val size = context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L
        if (size > MAX_FILE_BYTES) error("文件太大（上限 6MB）")
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            ?: error("无法读取这个文件")
        if (bytes.size > MAX_FILE_BYTES) error("文件太大（上限 6MB）")
        val name = displayName(uri)?.take(180) ?: "附件"
        Attachment.File(
            name = name,
            mimeType = context.contentResolver.getType(uri),
            bytesB64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
        )
    }

    private fun displayName(uri: Uri): String? = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
            }
    }.getOrNull()
}
