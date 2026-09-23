package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mpi.app.data.SessionState
import com.mpi.app.protocol.RemoteThreadState
import com.mpi.app.ui.theme.MpiTheme

/**
 * 主屏（对话即主页）：**不再有自己的会话列表** —— 会话列表就是左侧抽屉。
 *
 * 打开 App 会直接进最近/运行中的会话（见 AppViewModel 的自动打开）；这里只在
 * 「没有会话可开」时当底图用：顶栏 + 错误横幅 + 一句引导（点开抽屉选会话）。
 */
@Composable
fun HomeScreen(
    state: AppUiState,
    onOpenDrawer: () -> Unit,
    onRefresh: () -> Unit,
    onReconnect: () -> Unit,
    onOpenHosts: () -> Unit,
    onDismissProblems: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val host = state.host
    val session = state.session

    Column(modifier = modifier.fillMaxSize().statusBarsPadding()) {
        TopBar(
            state = state,
            onOpenDrawer = onOpenDrawer,
            onRefresh = onRefresh,
            onOpenHosts = onOpenHosts,
        )

        if (state.problems.isNotEmpty()) {
            Banner(
                text = state.problems.joinToString("；"),
                tone = Tone.Warning,
                actionLabel = "知道了",
                onAction = onDismissProblems,
            )
        }

        if (host.partialErrors.isNotEmpty()) {
            Banner(
                text = "部分项目加载失败：" + host.partialErrors.joinToString("；"),
                tone = Tone.Warning,
            )
        }

        val failure = (session as? SessionState.Failed)?.reason
        if (failure != null && failure.isTerminal) {
            Banner(text = session.label(), tone = Tone.Error, actionLabel = "添加设备", onAction = onOpenHosts)
        }

        if (host.error != null) {
            Banner(text = host.error, tone = Tone.Error, actionLabel = "重试", onAction = onRefresh)
        }

        when {
            // 有本地缓存时先渲染列表（秒开），连接状态交给顶栏，不拿转圈挡住一切
            (session is SessionState.Connecting || session is SessionState.Authenticating) &&
                host.projects.isEmpty() ->
                CenteredMessage(loading = true, text = session.label())

            failure != null && host.projects.isEmpty() ->
                CenteredMessage(text = session.label(), actionLabel = "立即重连", onAction = onReconnect)

            host.projects.isEmpty() && !host.loading ->
                CenteredMessage(
                    text = "这台电脑上还没有项目",
                    detail = "在电脑上打开一个项目后回到这里刷新",
                    actionLabel = "刷新",
                    onAction = onRefresh,
                )

            else -> CenteredMessage(
                text = "会话列表在侧栏里",
                detail = "点左上角菜单或下面的按钮打开，从里面选一个会话继续",
                actionLabel = "打开会话列表",
                onAction = onOpenDrawer,
            )
        }
    }
}

@Composable
private fun TopBar(
    state: AppUiState,
    onOpenDrawer: () -> Unit,
    onRefresh: () -> Unit,
    onOpenHosts: () -> Unit,
) {
    val online = state.session is SessionState.Connected
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 4.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onOpenDrawer) {
            Icon(IconMenu, contentDescription = "打开抽屉", tint = MaterialTheme.colorScheme.onSurface)
        }
        Column(Modifier.weight(1f)) {
            Text(
                text = state.activeHost?.shownName ?: "未选择主机",
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(7.dp).clip(CircleShape)
                        .background(if (online) MpiTheme.colors.ok else MpiTheme.colors.textFaint),
                )
                Spacer(Modifier.size(5.dp))
                Text(
                    text = if (online) {
                        "已连接"
                    } else if (state.host.cachedAt != null) {
                        // 断网首屏：列表来自磁盘缓存，必须说明白，不能让人以为是最新的
                        "离线 · 显示本地缓存（${relTime(state.host.cachedAt!!)}）"
                    } else {
                        state.session.label()
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        TextButton(onClick = onRefresh) { Text("刷新") }
        TextButton(onClick = onOpenHosts) { Text("主机") }
    }
}

@Composable
fun StateDot(state: RemoteThreadState, size: Int = 8) {
    val color = when (state) {
        RemoteThreadState.Running -> MpiTheme.colors.ok
        RemoteThreadState.Error -> MpiTheme.colors.err
        RemoteThreadState.Idle -> MpiTheme.colors.borderStrong
        RemoteThreadState.Draft, RemoteThreadState.Disconnected, RemoteThreadState.Unknown ->
            MpiTheme.colors.textFaint
    }
    Box(Modifier.size(size.dp).clip(CircleShape).background(color))
}

@Composable
private fun CenteredMessage(
    text: String,
    detail: String? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    loading: Boolean = false,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
            Spacer(Modifier.height(12.dp))
        }
        Text(text, style = MaterialTheme.typography.bodyLarge, color = MpiTheme.colors.textDim)
        if (detail != null) {
            Spacer(Modifier.height(6.dp))
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MpiTheme.colors.textFaint)
        }
        if (actionLabel != null && onAction != null) {
            Spacer(Modifier.height(14.dp))
            Button(onClick = onAction, shape = RoundedCornerShape(12.dp)) { Text(actionLabel) }
        }
    }
}

private enum class Tone { Info, Warning, Error }

@Composable
private fun Banner(
    text: String,
    tone: Tone,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val accent = when (tone) {
        Tone.Info -> MaterialTheme.colorScheme.primary
        Tone.Warning -> MpiTheme.colors.textDim
        Tone.Error -> MaterialTheme.colorScheme.error
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MpiTheme.colors.surfaceMuted)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = accent,
            modifier = Modifier.weight(1f),
        )
        if (actionLabel != null && onAction != null) {
            TextButton(onClick = onAction) { Text(actionLabel, fontWeight = FontWeight.Medium) }
        }
    }
}
