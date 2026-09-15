package com.mpi.remote

import android.annotation.SuppressLint
import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.URI

/**
 * MPI phone shell.
 *
 * A full-screen WebView on the self-hosted relay's PWA — the phone client is the
 * same H5 bundle the desktop ships (`mobile/pwa`), so all pairing, E2E crypto and
 * conversation logic live in JS; this shell only supplies an app-like window and a
 * native fallback UI when the relay cannot be reached.
 *
 * Deliberately NOT here (see docs/MOBILE-DESIGN.md §6.3): background notifications
 * and any WebRTC/direct transport — the shell is for "open it and watch the desktop
 * conversation", not for lock-screen wake-ups.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var errorPanel: LinearLayout
    private lateinit var errorText: TextView
    private lateinit var urlInput: EditText
    private lateinit var updateBar: LinearLayout
    private lateinit var updateText: TextView
    private var pendingUpdate: UpdateInfo? = null

    private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private val baseUrl: String get() = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL

    private lateinit var loadingOverlay: android.view.View

    /** WebView getUserMedia 请求挂起中（等运行时 RECORD_AUDIO 授权结果）。 */
    private var pendingAudioRequest: android.webkit.PermissionRequest? = null

    /** 回前台自动检查页面构建号的节流时间戳（毫秒）。 */
    private var lastPageCheckAt = 0L

    /**
     * WebView 文件选择器（拍照 / 相册 / 文件）挂起中的回调与相机输出 URI。
     *
     * Android WebView **默认不实现文件选择**：不覆写 `onShowFileChooser` 时，
     * 页面里的 `<input type=file>`（含 `capture` 拍照）点了完全没反应
     * ——2026-09-15 真机实测「拍照/发送图片是坏的」就是它。
     */
    private var fileChooserCallback: android.webkit.ValueCallback<Array<Uri>>? = null
    private var pendingCameraUri: Uri? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        ShellLog.init(this)
        ShellLog.log("onCreate base=$baseUrl")

        web = findViewById(R.id.web)
        loadingOverlay = findViewById(R.id.loadingOverlay)
        errorPanel = findViewById(R.id.errorPanel)
        errorText = findViewById(R.id.errorText)
        urlInput = findViewById(R.id.urlInput)

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        // PWA 靠 window.MpiShell 探测「在壳里」（据此显示扫码按钮），无需新协议。
        web.addJavascriptInterface(
            object {
                @JavascriptInterface
                fun scanPairQr() = runOnUiThread { startScan() }

                @JavascriptInterface
                fun shellVersion(): String = BuildConfig.VERSION_NAME

                /** ?dbg=1 诊断浮层读回：壳侧最近事件（load/scan/update），真机黑屏时定位用。 */
                @JavascriptInterface
                fun scanDiagnostics(): String = ShellLog.snapshot(BuildConfig.VERSION_NAME, baseUrl)

                /**
                 * 原生录音（PWA 语音输入在壳里的后端）——绕开 WebView 的音频栈，
                 * 见 NativeRecorder 的类注释。返回 "ok" 或 "err:<原因>"。
                 */
                @JavascriptInterface
                fun startRecording(): String {
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO)
                        != PackageManager.PERMISSION_GRANTED
                    ) {
                        runOnUiThread { audioPermission.launch(Manifest.permission.RECORD_AUDIO) }
                        return "err:permission"
                    }
                    return NativeRecorder.start()
                }

                /** 停止录音。返回 JSON：{ok,audioB64,sampleRate} 或 {error}。 */
                @JavascriptInterface
                fun stopRecording(): String = NativeRecorder.stop()

                @JavascriptInterface
                fun cancelRecording(): String {
                    NativeRecorder.cancel()
                    return "ok"
                }

                /** 原生录音最近一次启动结果（?dbg=1 取证）。 */
                @JavascriptInterface
                fun recorderDiagnostics(): String = NativeRecorder.lastResult
            },
            "MpiShell",
        )

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // the PWA keeps its pairing in IndexedDB
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        web.setBackgroundColor(Color.parseColor("#12141A"))

        // The PWA owns every scroll gesture inside its panes; a parent that
        // intercepts the touch stream makes long message lists stop scrolling.
        web.setOnTouchListener { view, _ ->
            view.parent?.requestDisallowInterceptTouchEvent(true)
            false
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.scheme == "https" || uri.scheme == "http") {
                    // Same-origin stays inside (file previews are served by the relay).
                    return !isAllowedHtmlPreviewUri(uri)
                }
                // mpi://pair… and friends are not navigations — let the system decide.
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                } catch (_: Exception) {
                    true
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    ShellLog.log("netError [${error.description}] ${request.url}")
                    loadingOverlay.visibility = View.GONE
                    errorPanel.visibility = View.VISIBLE
                    errorText.text = getString(R.string.shell_load_failed, "${error.description}\n${request.url}")
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                ShellLog.log("pageFinished $url")
                loadingOverlay.visibility = View.GONE
                errorPanel.visibility = View.GONE
            }

            /**
             * Debug builds accept the dev loopback tunnel (`adb reverse` to the
             * relay, whose certificate is issued for the tailnet name, not
             * 127.0.0.1). Release builds always fail closed.
             */
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                ShellLog.log("sslError [${error.primaryError}] ${view.url}")
                if (BuildConfig.DEBUG && view.url?.startsWith("https://127.0.0.1") == true) {
                    handler.proceed()
                } else {
                    handler.cancel()
                    loadingOverlay.visibility = View.GONE
                    errorPanel.visibility = View.VISIBLE
                    errorText.text = getString(R.string.shell_load_failed, "TLS：${error.primaryError}")
                }
            }
        }

        // composer 语音输入：WebView 默认拒绝所有 getUserMedia，必须显式授权。
        // 流程：页面请求 AUDIO_CAPTURE → 查运行时权限 → 已授直接 grant；
        // 未授先弹系统框（RECORD_AUDIO），结果回来再 grant/deny 挂起的请求。
        web.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                if (!request.resources.contains(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                    request.deny()
                    return
                }
                ShellLog.log("micPermission requested")
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED
                ) {
                    request.grant(request.resources)
                } else {
                    pendingAudioRequest = request
                    audioPermission.launch(Manifest.permission.RECORD_AUDIO)
                }
            }

            /**
             * 文件选择（拍照 / 相册 / 任意文件）。不覆写时页面 `<input type=file>`
             * 毫无反应——这是 WebView 的默认行为，不是页面问题。
             * 用 `FileChooserParams.createIntent()` 拿系统选择器（自动带多选与
             * accept 类型）；`isCaptureEnabled`（capture 属性，API 30+）则拉起相机。
             */
            override fun onShowFileChooser(
                view: WebView?,
                callback: android.webkit.ValueCallback<Array<Uri>>?,
                params: android.webkit.WebChromeClient.FileChooserParams?,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                val accepts = params?.acceptTypes?.joinToString(",") ?: ""
                val wantsCamera = params?.isCaptureEnabled == true || accepts.contains("capture")
                return try {
                    val intent = if (wantsCamera) cameraIntent() else params?.createIntent()
                    if (intent == null) {
                        fileChooserCallback = null
                        return false
                    }
                    fileChooserLauncher.launch(intent)
                    true
                } catch (t: Throwable) {
                    ShellLog.log("fileChooser fail ${t.javaClass.simpleName}:${t.message}")
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = null
                    false
                }
            }
        }

        findViewById<Button>(R.id.btnRetry).setOnClickListener { loadBase() }

        // 壳菜单：WebView 没有地址栏/刷新入口，页面若是旧版或地址存错就无从自救。
        findViewById<TextView>(R.id.shellMenu).setOnClickListener { anchor ->
            val popup = PopupMenu(this, anchor)
            popup.menu.add(0, MENU_RELOAD, 0, getString(R.string.shell_menu_reload))
            popup.menu.add(0, MENU_SERVER, 1, getString(R.string.shell_menu_server))
            popup.menu.add(0, MENU_DIAG, 2, getString(R.string.shell_menu_diag))
            popup.setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    MENU_RELOAD -> {
                        ShellLog.log("menuReload $baseUrl")
                        Toast.makeText(this, getString(R.string.shell_reloading), Toast.LENGTH_SHORT).show()
                        web.reload()
                        true
                    }
                    MENU_SERVER -> {
                        // 复用错误面板：它是壳里唯一能编辑地址的 UI。
                        urlInput.setText(baseUrl)
                        errorText.text = getString(R.string.shell_menu_server)
                        errorPanel.visibility = View.VISIBLE
                        true
                    }
                    MENU_DIAG -> {
                        showDiagnostics()
                        true
                    }
                    else -> false
                }
            }
            popup.show()
        }
        findViewById<Button>(R.id.btnSave).setOnClickListener {
            val typed = urlInput.text.toString().trim()
            if (typed.isNotEmpty()) prefs.edit().putString(KEY_BASE_URL, normalize(typed)).apply()
            loadBase()
        }

        // 自更新：启动几秒后静默比对中继清单，有新版本才浮出原生提示条。
        updateBar = findViewById(R.id.updateBar)
        updateText = findViewById(R.id.updateText)
        findViewById<Button>(R.id.updateAction).setOnClickListener { startUpdate() }
        findViewById<Button>(R.id.updateClose).setOnClickListener {
            pendingUpdate?.let { prefs.edit().putString(KEY_SKIPPED_VERSION, it.version).apply() }
            updateBar.visibility = View.GONE
        }
        web.postDelayed({ checkForUpdate() }, 3000)

        // "Open with MPI" on the relay URL re-points the shell (the only way to
        // change servers while the page itself loads fine).
        intent?.data?.let { adoptUrlFromIntent(it) }
        loadBase()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // 先问页面：「这一下返回我处理了吗」（抽屉逐级关闭、会话返回列表…）。
                // WebView 的 canGoBack() 不把 pushState 历史算进去，所以不能只靠它。
                web.evaluateJavascript("window.__mpiBack ? window.__mpiBack() : 'pass'") { result ->
                    if (result?.trim('"') == "handled") return@evaluateJavascript
                    if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
                }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let { uri ->
            if (adoptUrlFromIntent(uri)) loadBase()
        }
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        maybeReloadStalePage()
    }

    /**
     * 回前台时检查中继上的 bundle 是否已变（间隔 ≥60s）。
     *
     * WebView 会长期驻留——按返回只是退到后台、从多任务重开也不重载，于是可能
     * 一直跑旧页面（2026-09-15 实测）。页面构建号由 PWA 写入 `window.__mpi_build`
     * （壳契约 #11）；中继侧 `index.html` 是 no-cache，取到的一定是最新引用。
     */
    private fun maybeReloadStalePage() {
        val now = System.currentTimeMillis()
        if (now - lastPageCheckAt < 60_000) return
        lastPageCheckAt = now
        Thread {
            val served = Updater.pageBuild(baseUrl) ?: return@Thread
            runOnUiThread {
                web.evaluateJavascript("window.__mpi_build || ''") { raw ->
                    val loaded = raw?.trim('"')?.removePrefix("index-")?.removeSuffix(".js") ?: ""
                    val next = served.removePrefix("index-").removeSuffix(".js")
                    if (loaded.isBlank() || loaded == next) return@evaluateJavascript
                    ShellLog.log("stalePage reload served=$served loaded=$loaded")
                    Toast.makeText(this, getString(R.string.shell_page_updated), Toast.LENGTH_SHORT).show()
                    web.reload()
                }
            }
        }.start()
    }

    /** 壳诊断：地址 / 壳版本 / 页面构建号 / 最近壳事件——“界面是旧的”这类问题一屏定位。 */
    private fun showDiagnostics() {
        web.evaluateJavascript("window.__mpi_build || '(未知)'") { raw ->
            val pageBuild = raw?.trim('"') ?: "?"
            val events = ShellLog.recent(8).joinToString("\n")
            android.app.AlertDialog.Builder(this)
                .setTitle(R.string.shell_diag_title)
                .setMessage(
                    "壳版本: ${BuildConfig.VERSION_NAME}\n" +
                        "地址: $baseUrl\n" +
                        "页面构建: $pageBuild\n\n" +
                        events,
                )
                .setPositiveButton("好的", null)
                .show()
        }
    }

    /** 相机 intent：输出写进 FileProvider 暴露的 cacheDir/capture。 */
    private fun cameraIntent(): Intent {
        val directory = java.io.File(cacheDir, "capture").apply { mkdirs() }
        val file = java.io.File(directory, "shot-${System.currentTimeMillis()}.jpg")
        val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        pendingCameraUri = uri
        return Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** @return true when the intent carried a relay URL worth switching to. */
    private fun adoptUrlFromIntent(uri: Uri): Boolean {        if (uri.scheme != "https" && uri.scheme != "http") return false
        val next = normalize(uri.toString())
        if (next == baseUrl) return false
        prefs.edit().putString(KEY_BASE_URL, next).apply()
        return true
    }

    // ---- APK 自更新 ---------------------------------------------------------------

    /** 静默检查：有新版且用户没跳过这一版，才在顶部浮出提示条。 */
    private fun checkForUpdate() {
        Thread {
            val info = Updater.check(baseUrl)
            android.util.Log.i("MpiShell", "update check: base=$baseUrl result=${info?.version ?: "none"}")
            runOnUiThread {
                if (info == null) {
                    pendingUpdate = null
                    updateBar.visibility = View.GONE
                    return@runOnUiThread
                }
                if (info.version == prefs.getString(KEY_SKIPPED_VERSION, null)) return@runOnUiThread
                pendingUpdate = info
                updateText.text = getString(R.string.update_available, info.version)
                updateBar.visibility = View.VISIBLE
            }
        }.start()
    }

    private fun startUpdate() {
        val info = pendingUpdate ?: return
        updateText.text = getString(R.string.update_downloading, 0)
        findViewById<Button>(R.id.updateAction).isEnabled = false
        Thread {
            try {
                val apk = Updater.download(this, info) { percent ->
                    runOnUiThread { updateText.text = getString(R.string.update_downloading, percent) }
                }
                runOnUiThread {
                    updateText.text = getString(R.string.update_installing)
                    findViewById<Button>(R.id.updateAction).isEnabled = true
                    Updater.install(this, apk)
                }
            } catch (error: Exception) {
                runOnUiThread {
                    updateText.text = getString(R.string.update_failed, error.message ?: "download")
                    findViewById<Button>(R.id.updateAction).isEnabled = true
                }
            }
        }.start()
    }

    // ---- 壳内扫码 -----------------------------------------------------------------

    private val scanLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val scanned = result.data?.getStringExtra(ScanActivity.EXTRA_TEXT)
        if (result.resultCode == Activity.RESULT_OK && !scanned.isNullOrBlank()) {
            ShellLog.log("scanResult ok raw=${scanned.take(80)}")
            openScanned(scanned)
        } else {
            // 没识别到就明确告知，别让用户以为「扫了但没反应」。
            ShellLog.log("scanResult none")
            Toast.makeText(this, getString(R.string.scan_no_result), Toast.LENGTH_LONG).show()
        }
    }

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scanLauncher.launch(Intent(this, ScanActivity::class.java))
        else Toast.makeText(this, getString(R.string.scan_need_camera), Toast.LENGTH_LONG).show()
    }

    /** 运行时录音授权结果 → 结算挂起的 WebView getUserMedia 请求。 */
    private val audioPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        ShellLog.log("micPermission runtime=${if (granted) "ok" else "denied"}")
        pendingAudioRequest?.let { if (granted) it.grant(it.resources) else it.deny() }
        pendingAudioRequest = null
    }

    /** WebView 文件选择结果 → 回给页面的 FileChooser 回调（URI 数组）。 */
    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        val cameraUri = pendingCameraUri
        pendingCameraUri = null
        if (callback == null) return@registerForActivityResult
        if (result.resultCode != Activity.RESULT_OK) {
            callback.onReceiveValue(null) // 用户取消
            return@registerForActivityResult
        }
        val data = result.data
        val clip = data?.clipData
        val uris = when {
            clip != null -> (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
            data?.data != null -> listOf(data.data!!)
            cameraUri != null -> listOf(cameraUri)
            else -> emptyList()
        }
        ShellLog.log("fileChooser result n=${uris.size}${if (cameraUri != null) " camera" else ""}")
        callback.onReceiveValue(uris.toTypedArray().ifEmpty { null })
    }

    /** 供 PWA 的「扫码」按钮调用（JS 桥）。 */
    private fun startScan() {
        ShellLog.log("scanStart")
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            scanLauncher.launch(Intent(this, ScanActivity::class.java))
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    /** 扫码结果 → 交给 WebView。PWA 已支持 `#pair=` 自动配对，这里只做 URL 归一化。 */
    private fun openScanned(scanned: String) {
        val url = pairingUrlFrom(scanned)
        if (url == null) {
            ShellLog.log("scanResult notPairing raw=${scanned.take(80)}")
            Toast.makeText(this, getString(R.string.scan_not_pairing), Toast.LENGTH_LONG).show()
            return
        }
        loadExternal(url)
    }

    private fun pairingUrlFrom(scanned: String): String? {
        val value = scanned.trim()
        if (value.startsWith("https://") || value.startsWith("http://")) return value
        val match = Regex("^mpi://pair\\?payload=([A-Za-z0-9_-]+)$").find(value) ?: return null
        val payload = match.groupValues[1]
        val origin = relayOriginFromPayload(payload) ?: currentOrigin()
        return "$origin/#pair=$payload"
    }

    /** payload 里的 relayUrl 形如 wss://host:port/ws——取它的 HTTP 源作为页面来源。 */
    private fun relayOriginFromPayload(payload: String): String? = try {
        val json = String(Base64.decode(payload, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), Charsets.UTF_8)
        val relay = JSONObject(json).optString("relayUrl")
        if (relay.isBlank()) {
            null
        } else {
            val uri = URI(relay)
            val scheme = if (uri.scheme == "wss") "https" else "http"
            val port = if (uri.port > 0) ":${uri.port}" else ""
            "$scheme://${uri.host}$port"
        }
    } catch (_: Exception) {
        null
    }

    private fun currentOrigin(): String = Uri.parse(baseUrl).let { "${it.scheme}://${it.authority}" }

    /** 加载一个壳外发起的 URL（配对链接等）：目标源不同则同时换源。 */
    private fun loadExternal(url: String) {
        val origin = Uri.parse(url).let { "${it.scheme}://${it.authority}/" }
        if (origin != baseUrl) prefs.edit().putString(KEY_BASE_URL, origin).apply()
        ShellLog.log("loadUrl(external) $url")
        errorPanel.visibility = View.GONE
        urlInput.setText(url)
        // same-document 导航（只改 hash）不触发 onPageFinished——显示 overlay 会永远盖住页面。
        if (!isSameDocument(web.url, url)) loadingOverlay.visibility = View.VISIBLE
        web.loadUrl(url)
    }

    /** scheme/host/port/path/query 都相同、仅 fragment 不同 → same-document。 */
    private fun isSameDocument(current: String?, target: String): Boolean {
        val a = current?.let { runCatching { Uri.parse(it) }.getOrNull() } ?: return false
        val b = Uri.parse(target)
        return a.scheme == b.scheme && a.host == b.host && a.port == b.port &&
            a.path == b.path && a.query == b.query
    }

    /**
     * Only the configured relay origin may be loaded as a page inside the shell.
     * A preview entry that resolves to some other site (or a redirect elsewhere)
     * is handed to the system browser instead of running inside our app origin.
     */
    private fun isAllowedHtmlPreviewUri(uri: Uri): Boolean {
        if (uri.scheme == "http") return uri.host == "127.0.0.1" || uri.host == "localhost"
        if (uri.scheme != "https") return false
        val allowed = Uri.parse(baseUrl)
        return uri.host == allowed.host && uri.port == allowed.port
    }

    private fun normalize(raw: String): String {
        val withScheme = if (raw.startsWith("http://") || raw.startsWith("https://")) raw else "https://$raw"
        return withScheme.trimEnd('/') + "/"
    }

    private fun loadBase() {
        val url = baseUrl
        ShellLog.log("loadUrl $url")
        urlInput.setText(url)
        errorPanel.visibility = View.GONE
        loadingOverlay.visibility = View.VISIBLE
        web.loadUrl(url)
    }

    companion object {
        /** Default relay (tailnet-only, served with a Let's Encrypt cert). */
        const val DEFAULT_BASE_URL = "https://aliyun-ecs.tail38d5a.ts.net:9443/"
        private const val PREFS = "mpi-shell"
        private const val KEY_BASE_URL = "baseUrl"
        private const val MENU_RELOAD = 1
        private const val MENU_SERVER = 2
        private const val MENU_DIAG = 3
        /** 用户点「✕」跳过的版本，同一版不再反复提示（出现更新版本时重置）。 */
        private const val KEY_SKIPPED_VERSION = "skippedUpdateVersion"
    }
}
