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
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import com.mpi.app.protocol.RemoteThreadSummary
import com.mpi.app.ui.theme.MpiTheme

/** 首屏快捷动作。M2 起会被「输入框 + 示例提示词」取代（§4.3）。 */
enum class QuickAction(val label: String) {
    CheckRunning("看看桌面上在跑什么"),
    SwitchHost("换一台设备"),
    AddHost("添加设备"),
}

/**
 * 首屏（§4.3）：顶栏 + 欢迎区 + 快捷动作 + 最近会话（扁平、按更新时间倒序）。
 *
 * 抽屉里才是「按项目浏览」。首屏扁平是刻意的——千问的首屏也是「最近会话」，
 * 而不是先让人选项目。
 */
@Composable
fun HomeScreen(
    state: AppUiState,
    onOpenDrawer: () -> Unit,
    onRefresh: () -> Unit,
    onReconnect: () -> Unit,
    onOpenHosts: () -> Unit,
    onAddHost: () -> Unit,
    onDismissProblems: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val host = state.host
    val session = state.session

    Column(modifier = modifier.fillMaxSize()) {
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
            session is SessionState.Connecting || session is SessionState.Authenticating ->
                CenteredMessage(loading = true, text = session.label())

            failure != null ->
                CenteredMessage(text = session.label(), actionLabel = "立即重连", onAction = onReconnect)

            host.projects.isEmpty() && !host.loading ->
                CenteredMessage(
                    text = "这台电脑上还没有项目",
                    detail = "在电脑上打开一个项目后回到这里刷新",
                    actionLabel = "刷新",
                    onAction = onRefresh,
                )

            else -> Content(
                state = state,
                onRefresh = onRefresh,
                onOpenHosts = onOpenHosts,
                onAddHost = onAddHost,
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
                    text = if (online) "已连接" else state.session.label(),
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
private fun Content(
    state: AppUiState,
    onRefresh: () -> Unit,
    onOpenHosts: () -> Unit,
    onAddHost: () -> Unit,
) {
    val threads = state.host.allThreads

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp),
    ) {
        item(key = "welcome") {
            WelcomeBlock(
                deviceName = state.activeHost?.shownName ?: "你好",
                onAction = { action ->
                    when (action) {
                        QuickAction.CheckRunning -> onRefresh()
                        QuickAction.SwitchHost -> onOpenHosts()
                        QuickAction.AddHost -> onAddHost()
                    }
                },
            )
        }

        if (threads.isEmpty()) {
            item(key = "no-threads") {
                Text(
                    text = "这台电脑上还没有会话",
                    style = MaterialTheme.typography.bodySmall,
                    color = MpiTheme.colors.textFaint,
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 12.dp),
                )
            }
        } else {
            item(key = "recent-header") {
                Text(
                    text = "最近会话",
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textFaint,
                    modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 6.dp, bottom = 6.dp),
                )
            }
            items(threads, key = { it.id }) { thread ->
                ThreadRow(
                    thread = thread,
                    projectName = state.host.projects.firstOrNull { it.id == thread.projectId }?.name,
                )
            }
        }

        if (state.host.hasRunning) {
            item(key = "polling-note") {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(18.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp)
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
private fun WelcomeBlock(deviceName: String, onAction: (QuickAction) -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(34.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "M",
                    color = MaterialTheme.colorScheme.onPrimary,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(Modifier.size(10.dp))
            Text(
                text = "你好，$deviceName",
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Spacer(Modifier.height(12.dp))
        // 3 条快捷动作 —— 数量刻意少（§7 避坑 #4：千问 15 个胶囊是被批评的减法对象）
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            QuickAction.entries.forEach { action ->
                Surface(
                    onClick = { onAction(action) },
                    shape = RoundedCornerShape(10.dp),
                    color = MpiTheme.colors.surfaceMuted,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = action.label,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f),
                        )
                        Icon(
                            IconChevronRight,
                            contentDescription = null,
                            tint = MpiTheme.colors.textFaint,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ThreadRow(thread: RemoteThreadSummary, projectName: String?) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp),
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
            Text(
                text = buildString {
                    if (!projectName.isNullOrEmpty()) append("$projectName · ")
                    append(thread.state.label())
                    if (thread.messageCount > 0) append(" · ${thread.messageCount} 条")
                    append(" · ${relTime(thread.updatedAt)}")
                },
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
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
