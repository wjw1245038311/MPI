package com.mpi.app.data

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import com.mpi.app.BuildConfig
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

data class UpdateInfo(
    val version: String,
    val file: String,
    val url: String,
    val size: Long,
    val sha256: String,
    val github: String?,
)

/**
 * 语义化版本比较（纯函数，可测）：a > b 返回正数。
 * 非数字段按 0 处理——这样 `0.10` 会正确地大于 `0.9`。
 */
internal fun compareVersions(a: String, b: String): Int {
    val left = a.trim().removePrefix("v").split('.', '-', '+')
    val right = b.trim().removePrefix("v").split('.', '-', '+')
    val size = maxOf(left.size, right.size)
    for (i in 0 until size) {
        val l = left.getOrNull(i)?.takeWhile { it.isDigit() }?.toIntOrNull() ?: 0
        val r = right.getOrNull(i)?.takeWhile { it.isDigit() }?.toIntOrNull() ?: 0
        if (l != r) return l - r
    }
    return 0
}

/**
 * 自更新（M6）：读中继静态清单 → 比对版本 → 下载 → 校验 sha256 → 调系统安装器。
 *
 * 清单文件名 `mpi-android-native.json`（与旧壳的 `mpi-android.json` 区分），
 * 字段与旧壳保持一致：version / file / size / sha256 / publishedAt / github。
 *
 * 中继不可达、清单缺失、版本不比当前新 —— 一律**静默降级**（不弹错误）：
 * 更新检查是加分项，不该打扰正常使用（§1.1 的例外：这里没有用户触发的失败）。
 */
class Updater(private val context: Context) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    /** wss://host → https://host（中继的静态目录与信令同源）。 */
    fun httpOrigin(relayUrl: String): String? = relayUrl
        .trim()
        .replace(Regex("^wss://", RegexOption.IGNORE_CASE), "https://")
        .replace(Regex("^ws://", RegexOption.IGNORE_CASE), "http://")
        .trimEnd('/')
        .takeIf { it.startsWith("http") }

    /** 有更新时返回信息，否则 null。 */
    suspend fun check(relayUrl: String): UpdateInfo? = withContext(Dispatchers.IO) {
        val origin = httpOrigin(relayUrl) ?: return@withContext null
        runCatching {
            val request = Request.Builder().url("$origin/download/$MANIFEST_NAME").build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use null
                val body = response.body?.string() ?: return@use null
                parseManifest(body, origin)?.takeIf { isNewer(it.version) }
            }
        }.getOrNull()
    }

    /** 下载并校验；成功返回可安装的文件。 */
    suspend fun download(info: UpdateInfo): Result<File> = withContext(Dispatchers.IO) {
        runCatching {
            val target = File(context.cacheDir, "update-${info.version}.apk")
            val request = Request.Builder().url(info.url).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) error("下载失败（HTTP ${response.code}）")
                val body = response.body ?: error("下载失败：没有响应内容")
                target.outputStream().use { out -> body.byteStream().copyTo(out) }
            }
            if (info.sha256.isNotEmpty()) {
                val actual = sha256Of(target)
                if (!actual.equals(info.sha256, ignoreCase = true)) {
                    target.delete()
                    error("安装包校验失败，请重试")
                }
            }
            target
        }
    }

    /** 调起系统安装器（Android 8+ 首次需用户允许「安装未知应用」）。 */
    fun install(file: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    companion object {
        const val MANIFEST_NAME = "mpi-android-native.json"

        /** 当前安装版本比清单里的旧？（纯函数，可测） */
        internal fun isNewer(remote: String, current: String = BuildConfig.VERSION_NAME): Boolean =
            compareVersions(remote, current) > 0

        internal fun parseManifest(body: String, origin: String): UpdateInfo? {
            val obj = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
            val version = (obj["version"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
            val file = (obj["file"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
            if (version.isEmpty() || file.isEmpty()) return null
            return UpdateInfo(
                version = version,
                file = file,
                url = "$origin/download/$file",
                size = (obj["size"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: 0L,
                sha256 = (obj["sha256"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
                github = (obj["github"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() },
            )
        }

        internal fun sha256Of(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    digest.update(buffer, 0, read)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
