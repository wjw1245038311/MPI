package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mpi.app.protocol.UiRequest
import com.mpi.app.ui.theme.MpiTheme
import kotlinx.serialization.json.JsonObject

/**
 * 审批卡（§4.4 / §6.4）：agent 暂停等回应时停在输入条上方。
 *
 * **与设计文档的偏差（有意）**：文档写的是「从底部升起的 BottomSheet」，这里做成
 * **常驻卡片**。理由：agent 此刻是停住的，用户唯一下一步就是回答它；常驻卡片不遮挡
 * 上方的对话，用户想先翻看上下文再决定时不用来回开关弹层。这是手机端最有价值的交互，
 * 值得把「不遮挡」做实。
 *
 * 失败时**卡片不消失**，而是把原因显示在卡片内并允许重试——回应没送到就等于
 * agent 还停着，这时把卡片收掉会让人以为已经批准了。
 */
@Composable
fun ApprovalCard(
    request: UiRequest,
    responding: Boolean,
    error: String?,
    onRespond: (JsonObject) -> Unit,
    modifier: Modifier = Modifier,
) {
    var input by remember(request.id) { mutableStateOf(request.prefill.orEmpty()) }

    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
        shape = RoundedCornerShape(12.dp),
        color = MpiTheme.colors.surfaceMuted,
        tonalElevation = 0.dp,
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "需要你决定",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.size(6.dp))
                if (responding) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
            }

            if (!request.title.isNullOrBlank()) {
                Text(
                    text = request.title,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (!request.message.isNullOrBlank()) {
                Text(
                    text = request.message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MpiTheme.colors.textDim,
                )
            }

            request.diff?.let { DiffPreview(it) }

            if (error != null) {
                Text(
                    text = error,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            when {
                request.isSelect -> SelectOptions(request, responding, onRespond)

                request.isInput -> InputActions(request, input, { input = it }, responding, onRespond)

                else -> ConfirmActions(responding, onRespond)
            }

            TextButton(
                onClick = { onRespond(approvalCancel()) },
                enabled = !responding,
                modifier = Modifier.align(Alignment.End),
            ) {
                Text("取消", style = MaterialTheme.typography.labelSmall, color = MpiTheme.colors.textDim)
            }
        }
    }
}

@Composable
private fun SelectOptions(request: UiRequest, responding: Boolean, onRespond: (JsonObject) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        request.options.forEach { option ->
            Surface(
                onClick = { onRespond(approvalResponseFor(request.method, value = option)) },
                enabled = !responding,
                shape = RoundedCornerShape(10.dp),
                color = MpiTheme.colors.bg,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = option,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun InputActions(
    request: UiRequest,
    input: String,
    onInputChange: (String) -> Unit,
    responding: Boolean,
    onRespond: (JsonObject) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(
            value = input,
            onValueChange = onInputChange,
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text(request.placeholder ?: "输入内容") },
            maxLines = 5,
            shape = RoundedCornerShape(10.dp),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onRespond(approvalResponseFor(request.method, value = input.trim())) },
                enabled = !responding && canSubmitInput(request, input),
                shape = RoundedCornerShape(10.dp),
            ) {
                Text("提交")
            }
        }
    }
}

@Composable
private fun ConfirmActions(responding: Boolean, onRespond: (JsonObject) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
            onClick = { onRespond(approvalResponseFor("confirm", confirmed = true)) },
            enabled = !responding,
            shape = RoundedCornerShape(10.dp),
        ) {
            Text("允许")
        }
        TextButton(
            onClick = { onRespond(approvalResponseFor("confirm", confirmed = false)) },
            enabled = !responding,
        ) {
            Text("拒绝", color = MpiTheme.colors.err)
        }
    }
}

/** diff 预览（§4.5）：文件名 + 增删统计 + 绿/红行，等宽、横向可滚、超高可纵滚。 */
@Composable
private fun DiffPreview(diff: com.mpi.app.protocol.UiDiff) {
    val lines = remember(diff.hunks) { parseDiffLines(diff.hunks) }
    val vertical = rememberScrollState()
    val horizontal = rememberScrollState()

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = diff.path.ifEmpty { "改动" },
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MpiTheme.colors.textDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = "+${diff.added} −${diff.removed}",
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textDim,
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 220.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(MpiTheme.colors.codeBg)
                .verticalScroll(vertical)
                .padding(8.dp),
        ) {
            Column(Modifier.horizontalScroll(horizontal)) {
                lines.forEach { line ->
                    Text(
                        text = line.text.ifEmpty { " " },
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                            lineHeight = 17.sp,
                        ),
                        color = when (line.kind) {
                            DiffLineKind.Added -> MpiTheme.colors.ok
                            DiffLineKind.Removed -> MpiTheme.colors.err
                            DiffLineKind.Header -> MpiTheme.colors.textFaint
                            DiffLineKind.Context -> MpiTheme.colors.textDim
                        },
                    )
                }
            }
        }
        if (diff.truncated) {
            Text(
                text = "（diff 过长，主机已截断）",
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
            )
        }
    }
}
