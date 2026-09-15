package com.mpi.remote

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/** 一次可安装的更新。 */
data class UpdateInfo(val version: String, val url: String, val githubUrl: String, val sha256: String, val size: Long)

/**
 * APK 自更新：读中继上的 `/download/mpi-android.json` 比对壳版本 → 下载 → 校验 sha256 →
 * 交给系统安装器（Android 不允许静默安装，必须用户点一次系统弹窗）。
 *
 * 全部用 HttpURLConnection 手写：壳里没有网络库，也不值得为一个 JSON + 一个 APK 引入依赖。
 */
object Updater {

    private const val MANIFEST = "download/mpi-android.json"

    /** 远端版本比当前壳新则返回它，否则 null（含各种网络/解析失败：静默跳过）。 */
    fun check(baseUrl: String, headers: Map<String, String> = emptyMap()): UpdateInfo? {
        val origin = baseUrl.trimEnd('/')
        if (origin.isBlank()) return null
        val json = try {
            fetchText("$origin/$MANIFEST", headers)
        } catch (_: Exception) {
            return null
        }
        val manifest = try {
            JSONObject(json)
        } catch (_: Exception) {
            return null
        }
        val version = manifest.optString("version")
        val file = manifest.optString("file")
        if (version.isBlank() || file.isBlank()) return null
        if (compareVersions(version, BuildConfig.VERSION_NAME) <= 0) return null
        return UpdateInfo(
            version = version,
            url = "$origin/download/$file",
            githubUrl = manifest.optString("github"),
            sha256 = manifest.optString("sha256"),
            size = manifest.optLong("size"),
        )
    }

    /**
     * 下载到 `cacheDir/updates/`（FileProvider 只暴露这个目录）。中继失败而清单里带了
     * GitHub 直链时自动改走 GitHub。
     */
    fun download(context: Context, info: UpdateInfo, onProgress: (Int) -> Unit): File {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        val target = File(dir, "mpi-android-${info.version}.apk")
        val sources = listOfNotNull(info.url.takeIf { it.isNotBlank() }, info.githubUrl.takeIf { it.isNotBlank() })
        var lastError: Exception? = null
        for (source in sources) {
            try {
                downloadTo(source, target, info.sha256, onProgress)
                return target
            } catch (error: Exception) {
                lastError = error
                target.delete()
            }
        }
        throw lastError ?: IOException("没有可用的下载地址")
    }

    /** 调起系统安装器（首次会要求用户允许「安装未知应用」）。 */
    fun install(context: Context, apk: File) {
        val uri = FileProvider.getUriForFile(context, "${BuildConfig.APPLICATION_ID}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    private fun downloadTo(source: String, target: File, sha256: String, onProgress: (Int) -> Unit) {
        val connection = open(source).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            instanceFollowRedirects = true
        }
        try {
            connection.connect()
            val code = connection.responseCode
            if (code !in 200..299) throw IOException("HTTP $code")
            val total = connection.contentLengthLong
            val digest = MessageDigest.getInstance("SHA-256")
            var read = 0L
            connection.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val count = input.read(buffer)
                        if (count <= 0) break
                        output.write(buffer, 0, count)
                        digest.update(buffer, 0, count)
                        read += count
                        if (total > 0) onProgress(((read * 100) / total).toInt().coerceIn(0, 100))
                    }
                }
            }
            if (sha256.isNotBlank()) {
                val actual = digest.digest().joinToString("") { "%02X".format(it) }
                if (!actual.equals(sha256, ignoreCase = true)) throw IOException("SHA256 校验失败")
            }
        } finally {
            connection.disconnect()
        }
    }

    /** 读 PWA 页面里的构建号：解析 index.html 引用的 `assets/index-<hash>.js`。 */
    fun pageBuild(baseUrl: String): String? {
        val url = baseUrl.trimEnd('/') + "/index.html?ts=" + System.currentTimeMillis()
        val html = try {
            fetchText(url, mapOf("Cache-Control" to "no-cache"))
        } catch (_: Exception) {
            return null
        }
        return Regex("assets/(index-[A-Za-z0-9_-]+\\.js)").find(html)?.groupValues?.get(1)
    }

    private fun fetchText(url: String, headers: Map<String, String>): String {
        val connection = open(url).apply {
            connectTimeout = 8000
            readTimeout = 8000
            headers.forEach { (name, value) -> setRequestProperty(name, value) }
        }
        try {
            connection.connect()
            if (connection.responseCode !in 200..299) throw IOException("HTTP ${connection.responseCode}")
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * 建房连接。debug 构建对 `https://127.0.0.1`（宿主回环隧道）跳过证书校验，与 WebView
     * 的放行规则一致：中继证书签的是 tailnet 域名，走回环必然不匹配；release 永远 fail-closed。
     */
    private fun open(url: String): HttpURLConnection {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            setRequestProperty("User-Agent", "mpi-shell/${BuildConfig.VERSION_NAME}")
        }
        if (BuildConfig.DEBUG && url.startsWith("https://127.0.0.1") && connection is HttpsURLConnection) {
            val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            })
            val context = SSLContext.getInstance("TLS").apply { init(null, trustAll, SecureRandom()) }
            connection.sslSocketFactory = context.socketFactory
            connection.setHostnameVerifier { _, _ -> true }
        }
        return connection
    }

    /** 只比较点分数字段，忽略预发布后缀（`0.2.0` > `0.1.9`）。 */
    private fun compareVersions(a: String, b: String): Int {
        val left = a.trim().removePrefix("v").split(".", "-")
        val right = b.trim().removePrefix("v").split(".", "-")
        for (index in 0 until maxOf(left.size, right.size)) {
            val l = left.getOrNull(index)?.toIntOrNull() ?: 0
            val r = right.getOrNull(index)?.toIntOrNull() ?: 0
            if (l != r) return if (l > r) 1 else -1
        }
        return 0
    }
}
