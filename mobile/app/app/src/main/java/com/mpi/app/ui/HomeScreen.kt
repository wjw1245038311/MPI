package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import com.mpi.app.data.SessionFailure
import com.mpi.app.data.SessionState
import com.mpi.app.protocol.RemoteThreadState
import com.mpi.app.protocol.RemoteThreadSummary
import com.mpi.app.ui.theme.MpiTheme

/**
 * 首页（M1-5a：先把「能看见列表」做对；欢迎区/抽屉/图标见 M1-5b）。
 *
 * 失败态一律给「原因 + 一个可操作按钮」（§1.1）；空态给引导，不留白屏。
 */
@Composable
fun HomeScreen(
    state: AppUiState,
    onRefresh: () -> Unit,
    onReconnect: () -> Unit,
    onOpenHosts: () -> Unit,
    onDismissProblems: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val host = state.host
    val session = state.session

    Column(modifier = modifier.fillMaxSize()) {
        TopBar(state = state, onRefresh = onRefresh, onOpenHosts = onOpenHosts)

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

        // 终止性失败：重试没意义，必须重新配对
        val failure = (session as? SessionState.Failed)?.reason
        if (failure != null && failure.isTerminal) {
            Banner(
                text = session.label(),
                tone = Tone.Error,
                actionLabel = "添加设备",
                onAction = onOpenHosts,
            )
        }

        if (host.error != null) {
            Banner(
                text = host.error,
                tone = Tone.Error,
                actionLabel = "重试",
                onAction = onRefresh,
            )
        }

        when {
            // 认证中/连接中：给进度而不是空白
            session is SessionState.Connecting || session is SessionState.Authenticating -> {
                CenteredMessage(loading = true, text = session.label())
            }

            // 非终止性失败（网络/中继）：可重试，且会自动重连
            failure != null -> {
                CenteredMessage(
                    text = session.label(),
                    actionLabel = "立即重连",
                    onAction = onReconnect,
                )
            }

            host.projects.isEmpty() && !host.loading -> {
                CenteredMessage(
                    text = "这台电脑上还没有项目",
                    detail = "在电脑上打开一个项目后回到这里刷新",
                    actionLabel = "刷新",
                    onAction = onRefresh,
                )
            }

            else -> ThreadList(state = state, onRefresh = onRefresh)
        }
    }
}

@Composable
private fun TopBar(state: AppUiState, onRefresh: () -> Unit, onOpenHosts: () -> Unit) {
    val online = state.session is SessionState.Connected
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(10.dp).clip(CircleShape)
                .background(if (online) MpiTheme.colors.ok else MpiTheme.colors.textFaint),
        )
        Spacer(Modifier.size(8.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = state.activeHost?.shownName ?: "未选择主机",
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = if (online) "已连接" else state.session.label(),
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        TextButton(onClick = onRefresh) { Text("刷新") }
        TextButton(onClick = onOpenHosts) { Text("主机") }
    }
}

@Composable
private fun ThreadList(state: AppUiState, onRefresh: () -> Unit) {
    val host = state.host
    val showProjectHeaders = host.projects.size > 1

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        host.projects.forEach { project ->
            val threads = host.threadsByProject[project.id].orEmpty()
            if (threads.isEmpty() && !showProjectHeaders) return@forEach

            if (showProjectHeaders) {
                item(key = "project-${project.id}") {
                    Text(
                        text = project.name.ifEmpty { project.id },
                        style = MaterialTheme.typography.labelSmall,
                        color = MpiTheme.colors.textFaint,
                        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp),
                    )
                }
            }

            items(threads, key = { it.id }) { thread ->
                ThreadRow(thread)
            }

            if (threads.isEmpty()) {
                item(key = "empty-${project.id}") {
                    Text(
                        text = "（暂无会话）",
                        style = MaterialTheme.typography.bodySmall,
                        color = MpiTheme.colors.textFaint,
                        modifier = Modifier.padding(start = 16.dp, bottom = 6.dp),
                    )
                }
            }
        }

        if (host.hasRunning) {
            item(key = "polling-note") {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                    horizontalArrangement = Arrangement.Center,
                ) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(8.dp))
                    Text(
                        "有会话正在运行，列表自动刷新中",
                        style = MaterialTheme.typography.labelSmall,
                        color = MpiTheme.colors.textFaint,
                    )
                }
            }
        }
    }
}

@Composable
private fun ThreadRow(thread: RemoteThreadSummary) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StateDot(thread.state)
        Spacer(Modifier.size(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = thread.title.ifEmpty { "(无标题)" },
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val subtitle = buildString {
                append(thread.state.label())
                if (thread.messageCount > 0) append(" · ${thread.messageCount} 条")
                append(" · ${relTime(thread.updatedAt)}")
            }
            Text(
                text = subtitle,
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun StateDot(state: RemoteThreadState) {
    val color = when (state) {
        RemoteThreadState.Running -> MpiTheme.colors.ok
        RemoteThreadState.Error -> MpiTheme.colors.err
        RemoteThreadState.Unknown -> MpiTheme.colors.textFaint
        RemoteThreadState.Draft, RemoteThreadState.Disconnected -> MpiTheme.colors.textFaint
        RemoteThreadState.Idle -> MpiTheme.colors.borderStrong
    }
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
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

private enum class Tone { Warning, Error }

@Composable
private fun Banner(
    text: String,
    tone: Tone,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val accent = when (tone) {
        Tone.Warning -> MpiTheme.colors.textDim
        Tone.Error -> MaterialTheme.colorScheme.error
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
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
            TextButton(onClick = onAction) {
                Text(actionLabel, fontWeight = FontWeight.Medium)
            }
        }
    }
}
