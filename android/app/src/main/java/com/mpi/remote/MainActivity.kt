package com.mpi.remote

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.View
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

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

    private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private val baseUrl: String get() = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        errorPanel = findViewById(R.id.errorPanel)
        errorText = findViewById(R.id.errorText)
        urlInput = findViewById(R.id.urlInput)

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

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
                    errorPanel.visibility = View.VISIBLE
                    errorText.text = getString(R.string.shell_load_failed, "${error.description}\n${request.url}")
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                errorPanel.visibility = View.GONE
            }

            /**
             * Debug builds accept the dev loopback tunnel (`adb reverse` to the
             * relay, whose certificate is issued for the tailnet name, not
             * 127.0.0.1). Release builds always fail closed.
             */
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                if (BuildConfig.DEBUG && view.url?.startsWith("https://127.0.0.1") == true) {
                    handler.proceed()
                } else {
                    handler.cancel()
                    errorPanel.visibility = View.VISIBLE
                    errorText.text = getString(R.string.shell_load_failed, "TLS：${error.primaryError}")
                }
            }
        }

        findViewById<Button>(R.id.btnRetry).setOnClickListener { loadBase() }
        findViewById<Button>(R.id.btnSave).setOnClickListener {
            val typed = urlInput.text.toString().trim()
            if (typed.isNotEmpty()) prefs.edit().putString(KEY_BASE_URL, normalize(typed)).apply()
            loadBase()
        }

        // "Open with MPI" on the relay URL re-points the shell (the only way to
        // change servers while the page itself loads fine).
        intent?.data?.let { adoptUrlFromIntent(it) }
        loadBase()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
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
    private fun adoptUrlFromIntent(uri: Uri): Boolean {
        if (uri.scheme != "https" && uri.scheme != "http") return false
        val next = normalize(uri.toString())
        if (next == baseUrl) return false
        prefs.edit().putString(KEY_BASE_URL, next).apply()
        return true
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
        urlInput.setText(url)
        errorPanel.visibility = View.GONE
        web.loadUrl(url)
    }

    companion object {
        /** Default relay (tailnet-only, served with a Let's Encrypt cert). */
        const val DEFAULT_BASE_URL = "https://aliyun-ecs.tail38d5a.ts.net:9443/"
        private const val PREFS = "mpi-shell"
        private const val KEY_BASE_URL = "baseUrl"
    }
}
