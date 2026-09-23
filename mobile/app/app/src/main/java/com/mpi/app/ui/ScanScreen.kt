package com.mpi.app.ui

import androidx.activity.compose.BackHandler
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/**
 * 扫码配对（M4）：CameraX 预览 + ML Kit 条码识别。
 *
 * ML Kit 用 **bundled 模型**（离线可用，不需要 GMS）——旧壳已在这台设备上验证过。
 * 识别到第一条结果即回调并停止；**不自己解析协议**，交给 [normalizePairLink] +
 * `PairingLink`（配对链接的形状只有一处定义）。
 */
@Composable
fun ScanScreen(onResult: (String) -> Unit, onCancel: () -> Unit) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember { BarcodeScanning.getClient() }
    var handled by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            runCatching { scanner.close() }
            executor.shutdown()
        }
    }

    BackHandler(enabled = true) { onCancel() }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                val previewView = PreviewView(ctx)
                val providerFuture = ProcessCameraProvider.getInstance(ctx)
                providerFuture.addListener(
                    {
                        runCatching {
                            val provider = providerFuture.get()
                            val preview = Preview.Builder().build().also { p ->
                                p.setSurfaceProvider(previewView.surfaceProvider)
                            }
                            val analysis = ImageAnalysis.Builder()
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build()
                            analysis.setAnalyzer(executor) { imageProxy ->
                                val media = imageProxy.image
                                if (media == null || handled) {
                                    imageProxy.close()
                                    return@setAnalyzer
                                }
                                val input = InputImage.fromMediaImage(media, imageProxy.imageInfo.rotationDegrees)
                                scanner.process(input)
                                    .addOnSuccessListener { barcodes ->
                                        val value = barcodes.firstOrNull()?.rawValue
                                        if (!value.isNullOrBlank() && !handled) {
                                            handled = true
                                            onResult(value)
                                        }
                                    }
                                    .addOnCompleteListener { imageProxy.close() }
                            }
                            provider.unbindAll()
                            provider.bindToLifecycle(
                                lifecycleOwner,
                                CameraSelector.DEFAULT_BACK_CAMERA,
                                preview,
                                analysis,
                            )
                        }.onFailure { t ->
                            error = t.message ?: "相机启动失败"
                        }
                    },
                    ContextCompat.getMainExecutor(ctx),
                )
                previewView
            },
        )

        Text(
            text = "对准电脑上的配对二维码",
            color = Color.White,
            textAlign = TextAlign.Center,
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 48.dp, start = 24.dp, end = 24.dp),
        )

        if (error != null) {
            Text(
                text = error!!,
                color = Color(0xFFFF8A80),
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center).padding(24.dp),
            )
        }

        TextButton(
            onClick = onCancel,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 32.dp),
        ) {
            Text("取消", color = Color.White)
        }
    }
}

/**
 * 扫码结果 → 可交给 `PairingLink.parse` 的字符串。
 *
 * 支持三种形态（桌面二维码发的是第二种）：
 * 1. `mpi://pair?payload=…`
 * 2. `https://<relay>/#pair=…` → 还原成 `mpi://pair?payload=…`
 * 3. 裸 payload（base64url）
 *
 * 其它内容返回 null —— 调用方提示「这不是配对二维码」，不静默。
 */
internal fun normalizePairLink(raw: String): String? {
    val text = raw.trim()
    if (text.isEmpty()) return null
    if (text.startsWith("mpi://", ignoreCase = true)) return text

    val marker = "#pair="
    val index = text.indexOf(marker, ignoreCase = true)
    if (index >= 0) {
        val payload = text.substring(index + marker.length).trim()
        return if (payload.isEmpty()) null else "mpi://pair?payload=$payload"
    }

    return if (text.matches(Regex("^[A-Za-z0-9_-]{16,}$"))) text else null
}
