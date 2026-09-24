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

/** 增量包信息（清单里的 `patch` 字段）：只对 `from` 这一版有效。 */
data class UpdatePatch(
    val from: String,
    val file: String,
    val url: String,
    val size: Long,
    val sha256: String,
)

data class UpdateInfo(
    val version: String,
    val file: String,
    val url: String,
    val size: Long,
    val sha256: String,
    val github: String?,
    /** 有增量包时不为 null；是否可用还要看 `from` 是否等于当前安装版本。 */
    val patch: UpdatePatch? = null,
) {
    /** 本机能否走增量（基线版本必须正好等于当前安装版本）。 */
    fun patchUsable(currentVersion: String = BuildConfig.VERSION_NAME): Boolean =
        patch != null && patch.from == currentVersion
}

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
 * 清单文件名 `mpi-android-native.json`（与旧壳的 `mpi-android.json` 区分），字段：
 * `version / file / size / sha256 / publishedAt / github`，以及可选的
 * `patch: { from, file, size, sha256 }`——命中基线时只下增量包，用 [ApkPatch]
 * 与**已安装的 APK** 合并，再核对完整包的 sha256。
 *
 * 链路里任何一环不成立（基线不匹配、patch 下载失败、合并失败、校验不符）都
 * **自动回退下载完整包**——增量只是省流量，绝不能因此装不上。
 * 中继不可达 / 清单缺失 / 版本不新 → 静默降级（更新检查是加分项）。
 */
class Updater(private val context: Context) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    /** wss://host → https://host（中继的静态目录与信令同源）。 */
    fun httpOrigin(relayUrl: String): String? = relayUrl
        .trim()
        .replace(Regex("^wss://", RegexOption.IGNORE_CASE), "https://")
        .replace(Regex("^ws://", RegexOption.IGNORE_CASE), "http://")
        .trimEnd('/')
        .takeIf { it.startsWith("http") }

    /** 有更新时返回信息。优先 GitHub Release（用户要求），中继作兜底。 */
    suspend fun check(relayUrl: String): UpdateCheckResult = withContext(Dispatchers.IO) {
        val sources = buildList {
            add(GITHUB_MANIFEST_URL to GITHUB_BASE_URL)
            httpOrigin(relayUrl)?.let { origin -> add("$origin/download/$MANIFEST_NAME" to "$origin/download") }
        }
        var lastReason = "没有可用的更新源"
        for ((manifestUrl, base) in sources) {
            when (val result = fetchManifest(manifestUrl, base)) {
                is UpdateCheckResult.Failed -> lastReason = result.reason
                else -> return@withContext result
            }
        }
        UpdateCheckResult.Failed(lastReason)
    }

    private fun fetchManifest(manifestUrl: String, base: String): UpdateCheckResult =
        runCatching {
            val request = Request.Builder().url(manifestUrl).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    return@use UpdateCheckResult.Failed("没找到更新清单（HTTP ${response.code}）")
                }
                val body = response.body?.string()
                    ?: return@use UpdateCheckResult.Failed("更新清单是空的")
                val info = parseManifest(body, base)
                    ?: return@use UpdateCheckResult.Failed("更新清单格式不正确")
                if (isNewer(info.version)) UpdateCheckResult.Available(info) else UpdateCheckResult.UpToDate
            }
        }.getOrElse { error ->
            UpdateCheckResult.Failed("连接失败：${error.message ?: "未知错误"}")
        }

    /**
     * 优先走增量（基线匹配时），失败自动回退完整包；成功返回可安装的文件。
     * 返回值第二项告诉调用方走的是哪条路（用于界面提示）。
     */
    suspend fun download(info: UpdateInfo): Result<DownloadResult> = withContext(Dispatchers.IO) {
        runCatching {
            if (info.patchUsable()) {
                val viaPatch = runCatching { downloadViaPatch(info, info.patch!!) }
                viaPatch.getOrNull()?.let { return@runCatching DownloadResult(it, viaPatch = true) }
                // 增量失败（基线不符/下载坏/合并失败/校验不符）→ 落回全量
            }
            DownloadResult(downloadFull(info), viaPatch = false)
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

    // ---- 内部 ----

    private fun downloadFull(info: UpdateInfo): File {
        val target = File(context.cacheDir, "update-${info.version}.apk")
        fetchTo(info.url, target)
        if (info.sha256.isNotEmpty()) {
            val actual = sha256Of(target)
            if (!actual.equals(info.sha256, ignoreCase = true)) {
                target.delete()
                error("安装包校验失败，请重试")
            }
        }
        return target
    }

    private fun downloadViaPatch(info: UpdateInfo, patch: UpdatePatch): File {
        val patchFile = File(context.cacheDir, "patch-${info.version}.bin")
        fetchTo(patch.url, patchFile)
        try {
            val patchBytes = patchFile.readBytes()
            if (patch.sha256.isNotEmpty() && !sha256Of(patchBytes).equals(patch.sha256, ignoreCase = true)) {
                error("增量包校验失败")
            }
            // 当前已安装的 APK（增量基线）
            val installed = File(context.applicationInfo.sourceDir).readBytes()
            val merged = ApkPatch.apply(installed, patchBytes)
            if (info.sha256.isNotEmpty() && !sha256Of(merged).equals(info.sha256, ignoreCase = true)) {
                error("合并结果校验失败")
            }
            val target = File(context.cacheDir, "update-${info.version}.apk")
            target.writeBytes(merged)
            return target
        } finally {
            patchFile.delete()
        }
    }

    private fun fetchTo(url: String, target: File) {
        val request = Request.Builder().url(url).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("下载失败（HTTP ${response.code}）")
            val body = response.body ?: error("下载失败：没有响应内容")
            target.outputStream().use { out -> body.byteStream().copyTo(out) }
        }
    }

    companion object {
        const val MANIFEST_NAME = "mpi-android-native.json"

        /**
         * GitHub 侧：清单随仓库走（raw 固定 URL），安装包与增量包放 Release assets。
         *
         * 不能用 `releases/latest/download/…`：手机包是 prerelease，latest 不指向它；
         * 而若改成稳定版又会抢走桌面端自更新的 latest（AGENTS.md 里记过这个坑）。
         * 所以清单放仓库固定路径，里面的 file / patch.file 是 Release asset 的**绝对 URL**。
         */
        private const val GITHUB_REPO = "wjw1245038311/MPI"
        private const val GITHUB_MANIFEST_URL =
            "https://raw.githubusercontent.com/$GITHUB_REPO/main/mobile/app/update/$MANIFEST_NAME"

        /** 清单里给相对名时的拼接前缀；GitHub 模式留空（要求绝对 URL，否则走中继兜底）。 */
        private const val GITHUB_BASE_URL = ""

        /** 解析清单；base 是“文件所在目录”，file 为绝对 URL 时直接用。 */
        private fun assetUrl(base: String, file: String): String =
            if (file.startsWith("http://") || file.startsWith("https://")) file else "$base/$file"
        /** 当前安装版本比清单里的旧？（纯函数，可测） */
        internal fun isNewer(remote: String, current: String = BuildConfig.VERSION_NAME): Boolean =
            compareVersions(remote, current) > 0

        internal fun parseManifest(body: String, base: String): UpdateInfo? {
            val obj = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
            val version = (obj["version"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
            val file = (obj["file"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
            // `url` 优先（部分生成方只把绝对地址写在 url 里）；没有再回退 base + file。
            // 两者都是相对名时会拼出 “/xx.apk”，OkHttp 会报 “no scheme”——那是清单写错，
            // 不是客户端该静默掉的事，这里把错误留给调用方展示。
            val urlField = (obj["url"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
            if (version.isEmpty() || (file.isEmpty() && urlField.isEmpty())) return null

            val patchObj = obj["patch"] as? JsonObject
            val patch = patchObj?.let { p ->
                val from = (p["from"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
                val patchFile = (p["file"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
                val patchUrlField = (p["url"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
                if (from.isEmpty() || (patchFile.isEmpty() && patchUrlField.isEmpty())) {
                    null
                } else {
                    UpdatePatch(
                        from = from,
                        file = patchFile,
                        url = resolveAsset(base, patchUrlField, patchFile),
                        size = (p["size"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: 0L,
                        sha256 = (p["sha256"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
                    )
                }
            }

            return UpdateInfo(
                version = version,
                file = file,
                url = resolveAsset(base, urlField, file),
                size = (obj["size"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: 0L,
                sha256 = (obj["sha256"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
                github = (obj["github"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() },
                patch = patch,
            )
        }

        /** `url` 是绝对地址就用它，否则用 base + file（两者都是相对名 → 留给 OkHttp 报 no scheme）。 */
        private fun resolveAsset(base: String, urlField: String, file: String): String =
            if (urlField.startsWith("http://") || urlField.startsWith("https://")) urlField
            else assetUrl(base, file.ifEmpty { urlField })

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

        internal fun sha256Of(bytes: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256")
            digest.update(bytes)
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

/** 下载结果：文件 + 是否走了增量（界面据此提示）。 */
data class DownloadResult(val file: File, val viaPatch: Boolean)

/**
 * 检查更新结果。**不合并“没更新”与“拿不到清单”**——前者是正常结果，
 * 后者必须告诉用户原因（§1.1：用户主动点的操作不能静默失败）。
 */
sealed interface UpdateCheckResult {
    data class Available(val info: UpdateInfo) : UpdateCheckResult
    data object UpToDate : UpdateCheckResult
    data class Failed(val reason: String) : UpdateCheckResult
}
