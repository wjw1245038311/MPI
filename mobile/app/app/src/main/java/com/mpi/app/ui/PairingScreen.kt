package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mpi.app.ui.theme.MpiTheme

/**
 * 配对页（M1-5）。
 *
 * 只支持「粘贴链接」：扫码需要 CAMERA 权限与 CameraX，属于 M4 的原生能力；
 * 而桌面面板本来就提供「复制链接」，粘贴路径足够完成验收、也更省事。
 * （设计文档 §6 把扫码列在 M4，与这里一致。）
 */
@Composable
fun PairingScreen(
    state: AppUiState,
    onPair: (String) -> Unit,
    onClearError: () -> Unit,
    onCancel: (() -> Unit)?,
    onScan: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    var link by remember { mutableStateOf("") }
    val pairing = state.pairing
    val busy = pairing != null

    Column(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(56.dp).clip(CircleShape)
                .background(MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) {
            Text("M", color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Bold, fontSize = 22.sp)
        }

        Spacer(Modifier.height(16.dp))
        Text("连接你的电脑", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(6.dp))
        Text(
            text = "在电脑上打开 MPI → 设置 →「手机远程控制」→ 配对手机，" +
                "扫码时选「复制链接」，粘贴到下面。",
            style = MaterialTheme.typography.bodySmall,
            color = MpiTheme.colors.textDim,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(20.dp))
        OutlinedTextField(
            value = link,
            onValueChange = { link = it; if (state.pairingError != null) onClearError() },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("配对链接") },
            placeholder = { Text("mpi://pair?payload=… 或直接粘贴 payload") },
            minLines = 3,
            maxLines = 6,
            enabled = !busy,
            shape = RoundedCornerShape(12.dp),
        )

        Spacer(Modifier.height(14.dp))
        Button(
            onClick = { onPair(link) },
            enabled = !busy && link.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
        ) {
            Text(if (busy) "配对中…" else "开始配对")
        }

        if (onScan != null && !busy) {
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = onScan,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
            ) {
                Text("扫码配对")
            }
        }

        if (busy) {
            Spacer(Modifier.height(14.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Text(
                    text = pairing!!.stage.label(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MpiTheme.colors.textDim,
                )
            }
        }

        if (state.pairingError != null) {
            Spacer(Modifier.height(14.dp))
            Text(
                text = state.pairingError,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        if (onCancel != null) {
            Spacer(Modifier.height(6.dp))
            TextButton(onClick = onCancel, enabled = !busy) { Text("取消") }
        }
    }
}
