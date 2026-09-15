package com.mpi.remote

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.util.Size
import android.util.TypedValue
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 壳内扫码：CameraX 预览 + ML Kit 条码识别（bundled 模型，不依赖 Google Play 服务）。
 *
 * 只负责「识别到一串文本」，配对语义交给 PWA —— 识别结果回传 [EXTRA_TEXT]，由
 * [MainActivity] 拼成 `https://<relay>/#pair=<payload>` 交给 WebView（零协议改动）。
 */
class ScanActivity : AppCompatActivity() {

    private lateinit var previewView: PreviewView
    private lateinit var hint: TextView
    private var analysisExecutor: ExecutorService? = null
    private var scanner: BarcodeScanner? = null
    /** 识别到一条就停：相机帧是连续的，不加锁会重复回调。 */
    private var handled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        previewView = PreviewView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        hint = TextView(this).apply {
            text = getString(R.string.scan_hint)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            setPadding(28, 28, 28, 28)
            setBackgroundColor(Color.parseColor("#CC000000"))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM,
            )
        }
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#000000"))
            addView(previewView)
            addView(hint)
        })

        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            hint.text = getString(R.string.scan_need_camera)
            return
        }

        // 只认二维码：配对码就是二维码，限定格式能显著降低误识别与耗时。
        scanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
        )
        analysisExecutor = Executors.newSingleThreadExecutor()
        startCamera()
    }

    private fun startCamera() {
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            val provider = providerFuture.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            // 目标分辨率拉高：默认分析帧可能只有 640×480，密集二维码（version≥15）
            // 在这种分辨率下模块像素不足、识别失败。CameraX 会取不超过目标的最近尺寸。
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setTargetResolution(Size(1920, 1080))
                .build()
                .also { it.setAnalyzer(analysisExecutor!!, ::analyze) }
            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (error: Exception) {
                hint.text = getString(R.string.scan_failed, error.message ?: "camera")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun analyze(proxy: ImageProxy) {
        val media = proxy.image
        if (media == null || handled) {
            proxy.close()
            return
        }
        val image = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
        scanner?.process(image)
            ?.addOnSuccessListener { barcodes ->
                val value = barcodes.firstNotNullOfOrNull { it.rawValue ?: it.displayValue }
                if (value != null && !handled) {
                    handled = true
                    android.widget.Toast.makeText(this@ScanActivity, "已识别配对码，正在打开…", android.widget.Toast.LENGTH_SHORT).show()
                    setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_TEXT, value))
                    finish()
                }
            }
            ?.addOnCompleteListener { proxy.close() }
    }

    override fun onDestroy() {
        scanner?.close()
        analysisExecutor?.shutdown()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_TEXT = "scannedText"
    }
}
