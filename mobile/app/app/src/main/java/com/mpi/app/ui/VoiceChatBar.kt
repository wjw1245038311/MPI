package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mpi.app.ui.theme.MpiTheme

/**
 * 语音对话模式的状态条（贴在输入条上方，**不盖消息区**）。
 *
 * 为什么不做全屏浮层：语音模式下更该看到**对话本身**（消息气泡、流式回复）——千问手机版
 * 也是这样：语音只是输入方式，对话才是主体。全屏浮层把消息盖住，反而看不到它说到哪了。
 *
 * 这里**不放退出按钮**：开关就是输入条上那个话筒——语音模式开着时它已换成声波图标，
 * 点它退出（用户确定的口径：不要额外的 X）。
 */
@Composable
fun VoiceChatBar(
    state: VoiceChatState,
    lastText: String?,
) {
    val listening = state == VoiceChatState.Listening
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MpiTheme.colors.bg)
            .padding(start = 12.dp, end = 4.dp, top = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(26.dp)
                .clip(CircleShape)
                .background(if (listening) MpiTheme.colors.accentSoft else MpiTheme.colors.control),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = IconMic,
                contentDescription = null,
                tint = if (listening) MpiTheme.colors.send else MpiTheme.colors.textDim,
                modifier = Modifier.size(14.dp),
            )
        }
        Column(modifier = Modifier.weight(1f).padding(start = 10.dp)) {
            Text(
                text = voiceChatLabel(state),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            lastText?.takeIf { it.isNotBlank() }?.let { text ->
                Text(
                    text = "「$text」",
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textFaint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // 纯提示文字（不是按钮）：开关就是左边那颗话筒，图标已换成声波
        Text(
            text = "点话筒结束",
            style = MaterialTheme.typography.labelSmall,
            color = MpiTheme.colors.textFaint,
        )
    }
}

/** 状态条文案（纯函数，可单测）。 */
internal fun voiceChatLabel(state: VoiceChatState): String = when (state) {
    VoiceChatState.Listening -> "在听……说完停一下就行"
    VoiceChatState.Transcribing -> "正在识别"
    VoiceChatState.Thinking -> "等回复中"
    VoiceChatState.Speaking -> "正在播报"
}
