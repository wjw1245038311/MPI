package com.mpi.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import com.mpi.app.protocol.RemoteThreadSummary
import com.mpi.app.ui.theme.MpiTheme

/**
 * 会话搜索（M6+）：按标题/预览过滤当前主机的会话，点结果直接打开。
 *
 * 只搜**已经在手机上的列表**（主机不提供全文检索接口），所以文案上写清「会话」。
 * 输入为空时给最近会话，避免一片空白。
 */
@Composable
fun SearchScreen(
    threads: List<RemoteThreadSummary>,
    projectNameOf: (String) -> String?,
    onOpenThread: (String) -> Unit,
    onClose: () -> Unit,
) {
    var query by remember { mutableStateOf("") }

    val results = remember(query, threads) {
        val q = query.trim().lowercase()
        val matched = if (q.isEmpty()) {
            threads.sortedByDescending { it.updatedAt }
        } else {
            threads
                .filter { it.title.lowercase().contains(q) || it.preview.lowercase().contains(q) }
                .sortedByDescending { it.updatedAt }
        }
        matched.take(60)
    }

    BackHandler(enabled = true) { onClose() }

    Surface(color = MpiTheme.colors.bg, modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 2.dp, end = 10.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                IconButton(onClick = onClose) {
                    Icon(IconArrowLeft, contentDescription = "返回", tint = MaterialTheme.colorScheme.onSurface)
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("搜索会话", style = MaterialTheme.typography.bodyMedium) },
                    singleLine = true,
                    shape = RoundedCornerShape(12.dp),
                )
            }

            if (query.isNotBlank() && results.isEmpty()) {
                Text(
                    text = "没有匹配的会话",
                    style = MaterialTheme.typography.bodySmall,
                    color = MpiTheme.colors.textFaint,
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 12.dp),
                )
            }

            LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                items(results, key = { it.id }) { thread ->
                    SearchResultRow(
                        thread = thread,
                        projectName = projectNameOf(thread.projectId),
                        onClick = {
                            onOpenThread(thread.id)
                            onClose()
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun SearchResultRow(
    thread: RemoteThreadSummary,
    projectName: String?,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier.size(30.dp).clip(RoundedCornerShape(9.dp)).background(MpiTheme.colors.accentSoft),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = (thread.title.firstOrNull() ?: 'M').uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold,
            )
        }
        Column(Modifier.weight(1f)) {
            Text(
                text = thread.title.ifEmpty { "(无标题)" },
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = buildString {
                    if (!projectName.isNullOrEmpty()) append("$projectName · ")
                    if (thread.pinned) append("置顶 · ")
                    append(relTime(thread.updatedAt))
                },
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.size(2.dp))
    }
}
