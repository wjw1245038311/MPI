package com.mpi.app.data

import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** 登录成功后拿到的东西（落盘时整个结构进 SecretBox 加密的本地存储）。 */
@Serializable
data class AccountSession(
    val accountId: String,
    val kdfSalt: String,
    val token: String,
    val exp: Long = 0,
    /** 登录用的标识（手机号或邮箱），只用于界面回显与「重新登录」。 */
    val identifier: String = "",
)

/** 服务端回来的同步包（密文）。 */
@Serializable
data class AccountBlob(
    val ciphertext: String? = null,
    val revision: Int = 0,
    val updatedAt: String? = null,
)

class AccountApiException(message: String, val status: Int = 0) : Exception(message)

/**
 * 账号服务客户端（`/acct/…`，见仓库 `mobile/relay/account.mjs`）。
 *
 * 地址从**配对记录里的中继候选**推导：只用 `wss://…` 那条（账号接口只在中继的 TLS
 * 监听上，明文侧没有——密码不能裸奔）。推到 `https://host:port`。
 *
 * TLS：中继用的是自签 CA（`MPI Self-signed CA`，证书 SAN 里带 IP）。所以这里做 **TOFU**：
 * 首次从一个 `ws://`（明文，反正不加密）候选把 CA 取回来、缓存到内存，然后用它**只信这个
 * CA**去建立 https。没有 CA 可取（只有 wss 候选）时退回系统信任库（真实证书场景）。
 *
 * 为什么值得这么做：不像 TLS 那套，账号接口传的是密码与同步包，而明文侧会被运营商按
 * 指纹掐（安卓 OkHttp 实测），且密码绝不能走明文。
 */
class AccountApi(
    private val tlsBase: String,
    caPem: String? = null,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val mediaJson = "application/json; charset=utf-8".toMediaType()

    private val client: OkHttpClient = buildClient(caPem)

    /** 注册：成功后服务端直接给令牌（省一次登录）。 */
    suspend fun register(identifier: String, password: String): AccountSession =
        postSession("/acct/register", identifier, password)

    suspend fun login(identifier: String, password: String): AccountSession =
        postSession("/acct/login", identifier, password)

    /** 读同步包（没有就是 ciphertext=null）。 */
    suspend fun getBlob(token: String): AccountBlob = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("$tlsBase/acct/blob").header("authorization", "Bearer $token").get().build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw AccountApiException(errorOf(body, response.code), response.code)
            json.decodeFromString(AccountBlob.serializer(), body)
        }
    }

    /** 写同步包（覆盖式；revision 由服务端递增）。 */
    suspend fun putBlob(token: String, ciphertext: String, revision: Int): AccountBlob = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(
            BlobWrite.serializer(),
            BlobWrite(ciphertext = ciphertext, revision = revision),
        )
        val request = Request.Builder()
            .url("$tlsBase/acct/blob")
            .header("authorization", "Bearer $token")
            .put(payload.toRequestBody(mediaJson))
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw AccountApiException(errorOf(body, response.code), response.code)
            json.decodeFromString(AccountBlob.serializer(), body)
        }
    }

    @Serializable
    private data class BlobWrite(val ciphertext: String, val revision: Int)

    @Serializable
    private data class SessionResponse(
        val accountId: String,
        val kdfSalt: String,
        val token: String,
        val exp: Long = 0,
        val error: String? = null,
    )

    private suspend fun postSession(path: String, identifier: String, password: String): AccountSession =
        withContext(Dispatchers.IO) {
            val payload = json.encodeToString(
                Credentials.serializer(),
                Credentials(identifier = identifier.trim(), password = password),
            )
            val request = Request.Builder()
                .url("$tlsBase$path")
                .post(payload.toRequestBody(mediaJson))
                .build()
            client.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    // 409 = 已注册；401 = 账号或密码不对。都给可行动的文案。
                    val code = when {
                        response.code == 409 -> "这个账号已经注册过了，请直接登录"
                        response.code == 401 -> "账号或密码不对"
                        response.code == 429 -> "尝试太频繁，请稍后再试"
                        else -> errorOf(body, response.code)
                    }
                    throw AccountApiException(code, response.code)
                }
                val parsed = json.decodeFromString(SessionResponse.serializer(), body)
                AccountSession(
                    accountId = parsed.accountId,
                    kdfSalt = parsed.kdfSalt,
                    token = parsed.token,
                    exp = parsed.exp,
                    identifier = identifier.trim(),
                )
            }
        }

    @Serializable
    private data class Credentials(val identifier: String, val password: String)

    @Serializable
    private data class ErrorBody(val error: String? = null)

    private fun errorOf(body: String, status: Int): String {
        val code = runCatching { Json { ignoreUnknownKeys = true }.decodeFromString(ErrorBody.serializer(), body).error }.getOrNull()
        return when (code) {
            "BAD_IDENTIFIER" -> "账号格式不对（手机号或邮箱）"
            "BAD_PASSWORD" -> "密码至少 8 位"
            "ALREADY_EXISTS" -> "这个账号已经注册过了"
            "BAD_CREDENTIALS" -> "账号或密码不对"
            "RATE_LIMITED" -> "尝试太频繁，请稍后再试"
            "TOO_LARGE" -> "同步包太大（上限约 500KB）"
            "NOT_AUTHENTICATED" -> "登录已失效，请重新登录"
            null -> "账号服务返回 $status"
            else -> code
        }
    }

    companion object {
        /**
         * 从配对记录的中继候选里挑账号接口地址。
         *
         * 只认 `wss://`（账号接口只在中继 TLS 监听上）；取第一条就够——同一台中继的不同
         * 端口指向同一个进程。
         */
        fun tlsBaseOf(candidates: List<String>): String? {
            for (raw in candidates) {
                val url = raw.trim()
                if (!url.startsWith("wss://", ignoreCase = true)) continue
                val hostPart = url.removePrefix("wss://").substringBefore("/")
                if (hostPart.isBlank()) continue
                return "https://$hostPart"
            }
            return null
        }

        /** 明文候选（只在需要 TOFU 下载 CA 时用）。 */
        fun plainBaseOf(candidates: List<String>): String? {
            for (raw in candidates) {
                val url = raw.trim()
                if (!url.startsWith("ws://", ignoreCase = true)) continue
                val hostPart = url.removePrefix("ws://").substringBefore("/")
                if (hostPart.isBlank()) continue
                return "http://$hostPart"
            }
            return null
        }

        /**
         * 从明文侧取中继的 CA（`/mpi-selfsigned-ca.crt`，中继静态目录里就有一份）。
         *
         * 失败返回 null → 调用方退回系统信任库（真证书场景不需要这一步）。
         */
        suspend fun fetchCaPem(plainBase: String): String? = withContext(Dispatchers.IO) {
            runCatching {
                val client = OkHttpClient.Builder()
                    .connectTimeout(4, TimeUnit.SECONDS)
                    .readTimeout(4, TimeUnit.SECONDS)
                    .build()
                val request = Request.Builder().url("$plainBase/mpi-selfsigned-ca.crt").get().build()
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@use null
                    val pem = response.body?.string().orEmpty()
                    if (pem.contains("BEGIN CERTIFICATE")) pem else null
                }
            }.getOrNull()
        }

        private fun buildClient(caPem: String?): OkHttpClient {
            val builder = OkHttpClient.Builder()
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
            if (!caPem.isNullOrBlank()) {
                runCatching {
                    val factory = CertificateFactory.getInstance("X.509")
                    val ca = factory.generateCertificate(ByteArrayInputStream(caPem.toByteArray())) as X509Certificate
                    val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
                    keyStore.setCertificateEntry("mpi-relay-ca", ca)
                    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
                        init(keyStore)
                    }
                    val context = SSLContext.getInstance("TLS").apply {
                        init(null, tmf.trustManagers, null)
                    }
                    // 证书 SAN 里带 IP，所以默认 hostname 校验能过；这里仍显式指定，
                    // 免得不同 OkHttp 版本对 IP SAN 的处理差异把人绊住。
                    val verifier = javax.net.ssl.HostnameVerifier { host, session ->
                        session.peerCertificates.firstOrNull()?.let { cert ->
                            val x509 = cert as? X509Certificate ?: return@HostnameVerifier false
                            x509.subjectAlternativeNames?.any { entry ->
                                val text = entry.toString()
                                text.contains(host, ignoreCase = true)
                            } == true
                        } ?: false
                    }
                    builder.sslSocketFactory(context.socketFactory, tmf.trustManagers.first() as X509TrustManager)
                        .hostnameVerifier(verifier)
                }
            }
            return builder.build()
        }
    }
}
