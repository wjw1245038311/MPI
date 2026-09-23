package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
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
import com.mpi.app.ui.theme.MpiTheme

/**
 * 左侧抽屉（§4.5）：顶部当前主机 → 按项目浏览会话 → 底部设备操作。
 *
 * 刻意**不做**「新建会话」入口：M1 还没有 `thread.create`，放一个点了没反应的
 * 按钮违反 §1.1（禁止「点了没反应」）。它在 M2 随会话视图一起加。
 */
@Composable
fun AppDrawerContent(
    state: AppUiState,
    onOpenHosts: () -> Unit,
    onAddHost: () -> Unit,
    onRefresh: () -> Unit,
    onOpenThread: (String) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        DrawerHeader(
            deviceName = state.activeHost?.shownName ?: "未选择主机",
            online = state.session is SessionState.Connected,
            statusLabel = if (state.session is SessionState.Connected) "已连接" else state.session.label(),
            onClick = onOpenHosts,
        )

        HorizontalDivider(color = MpiTheme.colors.border)

        LazyColumn(
            modifier = Modifier.weight(1f, fill = false),
            contentPadding = PaddingValues(vertical = 8.dp),
        ) {
            val projects = state.host.projects
            if (projects.isEmpty()) {
                item(key = "empty") {
                    Text(
                        text = "暂无项目",
                        style = MaterialTheme.typography.bodySmall,
                        color = MpiTheme.colors.textFaint,
                        modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp),
                    )
                }
            }
            projects.forEach { project ->
                item(key = "project-${project.id}") {
                    Text(
                        text = project.name.ifEmpty { project.id },
                        style = MaterialTheme.typography.labelSmall,
                        color = MpiTheme.colors.textFaint,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 12.dp, bottom = 4.dp),
                    )
                }
                val threads = state.host.threadsByProject[project.id].orEmpty()
                if (threads.isEmpty()) {
                    item(key = "empty-${project.id}") {
                        Text(
                            text = "（暂无会话）",
                            style = MaterialTheme.typography.bodySmall,
                            color = MpiTheme.colors.textFaint,
                            modifier = Modifier.padding(start = 18.dp, bottom = 4.dp),
                        )
                    }
                } else {
                    items(threads, key = { it.id }) { thread ->
                        DrawerThreadRow(
                            title = thread.title,
                            state = thread.state,
                            updatedAt = thread.updatedAt,
                            onClick = { onOpenThread(thread.id) },
                        )
                    }
                }
            }
        }

        HorizontalDivider(color = MpiTheme.colors.border)
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            TextButton(onClick = onOpenHosts) { Text("切换设备") }
            TextButton(onClick = onAddHost) { Text("添加设备") }
            TextButton(onClick = onRefresh) { Text("刷新") }
        }
    }
}

@Composable
private fun DrawerHeader(
    deviceName: String,
    online: Boolean,
    statusLabel: String,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(38.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "M",
                color = MaterialTheme.colorScheme.onPrimary,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = deviceName,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                StateDotSize(online)
                Spacer(Modifier.size(5.dp))
                Text(
                    text = statusLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Text("切换", style = MaterialTheme.typography.labelSmall, color = MpiTheme.colors.textFaint)
    }
}

@Composable
private fun StateDotSize(online: Boolean) {
    Box(
        Modifier.size(7.dp).clip(CircleShape)
            .background(if (online) MpiTheme.colors.ok else MpiTheme.colors.textFaint),
    )
}

@Composable
private fun DrawerThreadRow(
    title: String,
    state: com.mpi.app.protocol.RemoteThreadState,
    updatedAt: Long,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StateDot(state, size = 7)
        Spacer(Modifier.size(9.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = title.ifEmpty { "(无标题)" },
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "${state.label()} · ${relTime(updatedAt)}",
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
