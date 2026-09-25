package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mpi.app.ui.theme.MpiTheme

/**
 * 语音对话模式浮层（阶段 1：**半双工**）。
 *
 * 长按麦克风 3 秒进入；这里只做两件事：把当前状态显示清楚（在听 / 识别中 / 等回复 / 播报中），
 * 以及给一个明确的退出入口。阶段 1 不做打断——播报时麦克风是关的，所以没有「说话即打断」。
 */
@Composable
fun VoiceChatOverlay(
    state: VoiceChatState,
    lastText: String?,
    error: String?,
    onStop: () -> Unit,
) {
    val listening = state == VoiceChatState.Listening
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xCC000000)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier
                .padding(horizontal = 28.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(MpiTheme.colors.surfaceMuted)
                .padding(horizontal = 22.dp, vertical = 24.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(84.dp)
                    .clip(CircleShape)
                    .background(if (listening) MpiTheme.colors.accentSoft else MpiTheme.colors.control),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = IconMic,
                    contentDescription = null,
                    tint = if (listening) MpiTheme.colors.send else MpiTheme.colors.textDim,
                    modifier = Modifier.size(34.dp),
                )
            }
            Text(
                text = voiceChatLabel(state),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )
            lastText?.takeIf { it.isNotBlank() }?.let { text ->
                Text(
                    text = "「$text」",
                    style = MaterialTheme.typography.bodySmall,
                    color = MpiTheme.colors.textDim,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
            }
            if (!error.isNullOrBlank()) {
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MpiTheme.colors.err,
                    textAlign = TextAlign.Center,
                )
            }
            TextButton(onClick = onStop) { Text("结束语音模式") }
        }
    }
}

/** 浮层状态文案（纯函数，可单测）。 */
internal fun voiceChatLabel(state: VoiceChatState): String = when (state) {
    VoiceChatState.Listening -> "在听……说完停一下就行"
    VoiceChatState.Transcribing -> "正在识别"
    VoiceChatState.Thinking -> "等回复中"
    VoiceChatState.Speaking -> "正在播报"
}
