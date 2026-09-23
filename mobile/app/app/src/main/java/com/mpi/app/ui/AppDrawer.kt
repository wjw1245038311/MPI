package com.mpi.app.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mpi.app.data.SessionState
import com.mpi.app.protocol.RemoteProject
import com.mpi.app.protocol.RemoteThreadSummary
import com.mpi.app.ui.theme.MpiTheme

/**
 * 左侧抽屉（§4.5）：顶部当前主机 → 新建会话 → 按项目浏览会话 → 底部设备操作。
 *
 * 会话在项目内再按【今天 / 昨天 / 更早】分组（PWA 同款，`MOBILE-UX-PLAN` §3）。
 */
@Composable
fun AppDrawerContent(
    state: AppUiState,
    onOpenHosts: () -> Unit,
    onAddHost: () -> Unit,
    onRefresh: () -> Unit,
    onOpenThread: (String) -> Unit,
    onNewThread: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onRename: (String, String) -> Unit = { _, _ -> },
    onTogglePin: (String, Boolean) -> Unit = { _, _ -> },
    onDelete: (String) -> Unit = {},
) {
    var menuFor by remember { mutableStateOf<RemoteThreadSummary?>(null) }
    // 项目折叠态：一次只展开一个（与 PWA `expandedProjectId` 同语义），默认全收起
    var expandedProjectId by remember { mutableStateOf<String?>(null) }
    Column(modifier = Modifier.fillMaxWidth().statusBarsPadding()) {
        DrawerHeader(
            deviceName = state.activeHost?.shownName ?: "未选择主机",
            online = state.session is SessionState.Connected,
            statusLabel = if (state.session is SessionState.Connected) "已连接" else state.session.label(),
            onClick = onOpenHosts,
        )

        HorizontalDivider(color = MpiTheme.colors.border)

        NewThreadEntry(
            projects = state.host.projects,
            creating = state.creatingThread,
            onNewThread = onNewThread,
        )

        HorizontalDivider(color = MpiTheme.colors.border)

        LazyColumn(
            modifier = Modifier.weight(1f, fill = false),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val projects = state.host.projects
            if (projects.isEmpty()) {
                item(key = "empty") {
                    Text(
                        text = "暂无项目",
                        style = MaterialTheme.typography.bodySmall,
                        color = MpiTheme.colors.textFaint,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 10.dp),
                    )
                }
            }
            val now = System.currentTimeMillis()
            projects.forEach { project ->
                val threads = state.host.threadsByProject[project.id].orEmpty()
                val expanded = expandedProjectId == project.id
                item(key = "project-${project.id}") {
                    DrawerProjectCard(
                        name = project.name.ifEmpty { project.id },
                        // 与 PWA 同一口径：项目行的「N 会话 · 相对时间」
                        hint = projectRowHint(project.threadCount, project.updatedAt, now),
                        expanded = expanded,
                        onToggle = { expandedProjectId = if (expanded) null else project.id },
                        threads = if (expanded) threads else emptyList(),
                        now = now,
                        onOpenThread = onOpenThread,
                        onLongClick = { menuFor = it },
                    )
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
            TextButton(onClick = onOpenSettings) { Text("设置") }
        }
    }

    // 长按会话 → 重命名 / 置顶 / 删除（手机端的会话管理入口）
    menuFor?.let { thread ->
        ThreadActionDialog(
            title = thread.title.ifEmpty { "(无标题)" },
            pinned = thread.pinned,
            busy = false,
            onDismiss = { menuFor = null },
            onRename = { name ->
                menuFor = null
                onRename(thread.id, name)
            },
            onTogglePin = { pinned ->
                menuFor = null
                onTogglePin(thread.id, pinned)
            },
            onDelete = {
                menuFor = null
                onDelete(thread.id)
            },
        )
    }
}

/**
 * 项目卡片（抽屉第一层）：项目名 + 「N 会话 · 相对时间」，点击展开该项目下的会话。
 *
 * 对齐 PWA `App.tsx` 的 `.project` / `.project-row`：有边框圆角卡片，展开后
 * 会话行用分隔线挂在同一张卡片里；展开态由调用方（单一 `expandedProjectId`）控制。
 * 项目内仍按【今天 / 昨天 / 更早】分小标题（原生保留的细化，不影响收起态观感）。
 */
@Composable
private fun DrawerProjectCard(
    name: String,
    hint: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    threads: List<RemoteThreadSummary>,
    now: Long,
    onOpenThread: (String) -> Unit,
    onLongClick: (RemoteThreadSummary) -> Unit,
) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MpiTheme.colors.surfaceMuted)
            .border(1.dp, MpiTheme.colors.border, shape),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.size(8.dp))
            Text(
                text = hint,
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
                maxLines = 1,
            )
        }
        if (expanded) {
            HorizontalDivider(color = MpiTheme.colors.border)
            if (threads.isEmpty()) {
                Text(
                    text = "（暂无会话）",
                    style = MaterialTheme.typography.bodySmall,
                    color = MpiTheme.colors.textFaint,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                )
            } else {
                drawerDayGroups(threads, now).forEach { (label, groupThreads) ->
                    Text(
                        text = label,
                        style = MaterialTheme.typography.labelSmall,
                        color = MpiTheme.colors.textFaint,
                        modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 2.dp),
                    )
                    groupThreads.forEach { thread ->
                        DrawerThreadRow(
                            title = thread.title,
                            state = thread.state,
                            updatedAt = thread.updatedAt,
                            pinned = thread.pinned,
                            onClick = { onOpenThread(thread.id) },
                            onLongClick = { onLongClick(thread) },
                        )
                    }
                }
            }
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DrawerThreadRow(
    title: String,
    state: com.mpi.app.protocol.RemoteThreadState,
    updatedAt: Long,
    pinned: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
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
                text = if (pinned) "置顶 · ${state.label()} · ${relTime(updatedAt)}" else "${state.label()} · ${relTime(updatedAt)}",
                style = MaterialTheme.typography.labelSmall,
                color = if (pinned) MaterialTheme.colorScheme.primary else MpiTheme.colors.textFaint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * 会话长按菜单：重命名 / 置顶 / 删除。
 *
 * 删除走主机回收站（可恢复），所以文案里要如实说明——不让用户以为不可逆。
 * 置顶态主机列表不返回，菜单按本端已知状态显示「置顶 / 取消置顶」。
 */
@Composable
internal fun ThreadActionDialog(
    title: String,
    pinned: Boolean,
    busy: Boolean,
    onDismiss: () -> Unit,
    onRename: (String) -> Unit,
    onTogglePin: (Boolean) -> Unit,
    onDelete: () -> Unit,
) {
    var renaming by remember(title) { mutableStateOf(false) }
    var confirmingDelete by remember(title) { mutableStateOf(false) }
    var draft by remember(title) { mutableStateOf(title) }

    when {
        renaming -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("重命名会话") },
            text = {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("会话名称", style = MaterialTheme.typography.bodySmall) },
                )
            },
            confirmButton = {
                TextButton(onClick = { onRename(draft) }, enabled = draft.isNotBlank() && !busy) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
        )

        confirmingDelete -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("删除会话？") },
            text = { Text("会话会移入电脑上的回收站，可在桌面端设置「数据管理」里恢复。") },
            confirmButton = {
                TextButton(onClick = onDelete, enabled = !busy) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
        )

        else -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            text = {
                Column(Modifier.fillMaxWidth()) {
                    TextButton(onClick = { renaming = true }, modifier = Modifier.fillMaxWidth()) { Text("重命名") }
                    TextButton(onClick = { onTogglePin(!pinned) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Text(if (pinned) "取消置顶" else "置顶")
                    }
                    TextButton(
                        onClick = { confirmingDelete = true },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("删除", color = MaterialTheme.colorScheme.error)
                    }
                }
            },
            confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
        )
    }
}

/**
 * 抽屉「新建会话」入口：单项目直接建；多项目先内联选项目。
 * 新建按钮在请求进行中禁用，避免连点建出多条空会话。
 */
@Composable
private fun NewThreadEntry(
    projects: List<RemoteProject>,
    creating: String?,
    onNewThread: (String) -> Unit,
) {
    if (projects.isEmpty()) return
    var choosing by remember { mutableStateOf(false) }
    val busy = creating != null

    if (projects.size == 1 && !choosing) {
        TextButton(
            onClick = { onNewThread(projects.first().id) },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
        ) {
            Icon(IconPlus, contentDescription = null, modifier = Modifier.size(15.dp))
            Spacer(Modifier.size(6.dp))
            Text(if (busy) "新建中…" else "新建会话")
        }
        return
    }

    Column(Modifier.fillMaxWidth()) {
        TextButton(
            onClick = { choosing = !choosing },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
        ) {
            Icon(IconPlus, contentDescription = null, modifier = Modifier.size(15.dp))
            Spacer(Modifier.size(6.dp))
            Text(if (busy) "新建中…" else "新建会话（选择项目）")
        }
        if (choosing) {
            projects.forEach { project ->
                TextButton(
                    onClick = {
                        choosing = false
                        onNewThread(project.id)
                    },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().padding(start = 22.dp, end = 8.dp),
                ) {
                    Text(
                        text = project.name.ifEmpty { project.id },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

// ---- 抽屉分组（纯函数，可单测） ---------------------------------------------

/** 项目行右侧文案：与 PWA `App.tsx` 的 `{threadCount} 会话 · {relTime}` 完全一致。 */
internal fun projectRowHint(threadCount: Int, updatedAt: Long, now: Long = System.currentTimeMillis()): String =
    "$threadCount 会话 · ${relTime(updatedAt, now)}"

/** 会话落在「今天 / 昨天 / 更早」（按本地日历日，不用 24h 差值以免跨零点错位）。 */
internal fun dayBucketLabel(updatedAt: Long, now: Long): String {
    val calendar = java.util.Calendar.getInstance()
    fun startOfDay(ts: Long): Long {
        calendar.timeInMillis = ts
        calendar.set(java.util.Calendar.HOUR_OF_DAY, 0)
        calendar.set(java.util.Calendar.MINUTE, 0)
        calendar.set(java.util.Calendar.SECOND, 0)
        calendar.set(java.util.Calendar.MILLISECOND, 0)
        return calendar.timeInMillis
    }
    val today = startOfDay(now)
    val day = startOfDay(updatedAt)
    val yesterday = startOfDay(today - 1)
    return when {
        day >= today -> "今天"
        day >= yesterday -> "昨天"
        else -> "更早"
    }
}

/** 分组后的会话（每组按更新时间倒序；空组不出现）。 */
internal fun drawerDayGroups(
    threads: List<RemoteThreadSummary>,
    now: Long,
): List<Pair<String, List<RemoteThreadSummary>>> = listOf("今天", "昨天", "更早").mapNotNull { label ->
    val items = threads
        .filter { dayBucketLabel(it.updatedAt, now) == label }
        .sortedByDescending { it.updatedAt }
    if (items.isEmpty()) null else label to items
}
