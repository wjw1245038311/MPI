package com.mpi.app.ui

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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.RemoteThreadState
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.ui.theme.MpiTheme
import kotlinx.coroutines.launch

/**
 * 会话视图（§4.4）：顶栏 + 消息流。
 *
 * 错误一律**顶部横幅 + 可操作按钮**（§1.1），不遮住内容；滚动跟随在用户手动上滑时
 * 自动停止，并浮出「回到底部」——避免读到一半被流式输出拽走。
 */
@Composable
fun ThreadScreen(
    view: ThreadView,
    projectName: String?,
    onBack: () -> Unit,
    onResync: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val renderable = view.renderable
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }

    // 内容增长时仅在「本来就在底部」的前提下跟随
    LaunchedEffect(renderable.size, view.streaming?.blocks?.lastOrNull()?.text?.length) {
        if (renderable.isNotEmpty() && atBottom) {
            listState.scrollToItem(renderable.lastIndex)
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        ThreadTopBar(
            title = view.summary?.title?.ifEmpty { null } ?: "会话",
            projectName = projectName,
            state = view.summary?.state,
            running = view.running,
            compacting = view.compacting,
            onBack = onBack,
        )

        if (view.errorBanner != null) {
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
                    text = view.errorBanner,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onResync) { Text("重新同步") }
            }
        }

        Box(Modifier.weight(1f)) {
            when {
                !view.ready -> CenteredHint(text = "正在载入会话…", loading = true)

                renderable.isEmpty() -> CenteredHint(text = "这个会话还没有消息")

                else -> LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(vertical = 10.dp),
                ) {
                    items(renderable, key = { it.id }) { message -> MessageRow(message) }
                }
            }

            if (!atBottom && renderable.isNotEmpty()) {
                ScrollToBottomButton(
                    listState = listState,
                    itemCount = renderable.size,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 6.dp),
                )
            }
        }
    }
}

@Composable
private fun ScrollToBottomButton(
    listState: androidx.compose.foundation.lazy.LazyListState,
    itemCount: Int,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    TextButton(
        modifier = modifier,
        onClick = { scope.launch { if (itemCount > 0) listState.scrollToItem(itemCount - 1) } },
    ) {
        Text("回到底部", style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun ThreadTopBar(
    title: String,
    projectName: String?,
    state: RemoteThreadState?,
    running: Boolean,
    compacting: Boolean,
    onBack: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 2.dp, end = 8.dp, top = 6.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(IconArrowLeft, contentDescription = "返回", tint = MaterialTheme.colorScheme.onSurface)
        }
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (state != null) {
                    StateDot(state, size = 7)
                    Spacer(Modifier.size(5.dp))
                }
                Text(
                    text = buildString {
                        if (!projectName.isNullOrEmpty()) append("$projectName · ")
                        append(state?.label() ?: "状态未知")
                        if (running) append(" · 运行中")
                        if (compacting) append(" · 压缩中")
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (running || compacting) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
        }
    }
}

@Composable
private fun MessageRow(message: ThreadMessage) {
    if (message.role == "user") {
        UserMessageRow(message)
    } else {
        AssistantMessageRow(message)
    }
}

@Composable
private fun UserMessageRow(message: ThreadMessage) {
    val failed = message.errorMessage != null
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Column(horizontalAlignment = Alignment.End) {
            Box(
                Modifier
                    .widthIn(max = 300.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (failed) MpiTheme.colors.surfaceMuted else MpiTheme.colors.userBubble)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Column {
                    message.blocks.filter { it.type == BlockType.Text }.forEach { block ->
                        MessageText(block.text.orEmpty(), color = MaterialTheme.colorScheme.onSurface)
                    }
                    if (message.pending) {
                        Text(
                            text = "发送中…",
                            style = MaterialTheme.typography.labelSmall,
                            color = MpiTheme.colors.textFaint,
                        )
                    }
                }
            }
            if (failed) {
                Text(
                    text = message.errorMessage.orEmpty(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = 2.dp, end = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun AssistantMessageRow(message: ThreadMessage) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier.size(26.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "M",
                color = MaterialTheme.colorScheme.onPrimary,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            message.blocks.forEachIndexed { index, block ->
                when (block.type) {
                    BlockType.Tool -> ToolBlockRow(block, key = "${message.id}-tool-$index")
                    BlockType.Thinking -> ThinkingBlockRow(block, key = "${message.id}-think-$index")
                    BlockType.Image -> ImageBlockHint(block)
                    BlockType.Text -> if (!block.text.isNullOrBlank()) {
                        MessageText(block.text)
                    }
                }
            }
            if (message.errorMessage != null) {
                Text(
                    text = message.errorMessage,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

/** 工具行：默认折成一行（§4.4 / §7 避坑 #4）；点击展开参数与结果。 */
@Composable
private fun ToolBlockRow(block: MessageBlock, key: String) {
    var expanded by remember(key) { mutableStateOf(false) }
    val label = block.name ?: "工具"
    val preview = block.argsText?.let { " · ${it.take(40)}" }.orEmpty()

    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { expanded = !expanded }
                .padding(vertical = 4.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (expanded) "▾" else "▸",
                style = MaterialTheme.typography.bodySmall,
                color = MpiTheme.colors.textFaint,
            )
            Spacer(Modifier.size(6.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = if (block.isError) MpiTheme.colors.err else MpiTheme.colors.textDim,
            )
            if (!expanded && preview.isNotEmpty()) {
                Text(
                    text = preview,
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textFaint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (block.running) {
                Spacer(Modifier.size(6.dp))
                CircularProgressIndicator(Modifier.size(11.dp), strokeWidth = 2.dp)
            }
        }
        if (expanded) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(MpiTheme.colors.codeBg)
                    .padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (!block.argsText.isNullOrBlank()) {
                    Text(
                        text = block.argsText,
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                        ),
                        color = MpiTheme.colors.textDim,
                    )
                }
                if (!block.text.isNullOrBlank()) {
                    Text(
                        text = block.text,
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                        ),
                        color = if (block.isError) MpiTheme.colors.err else MaterialTheme.colorScheme.onSurface,
                    )
                } else if (block.running) {
                    Text("执行中…", style = MaterialTheme.typography.labelSmall, color = MpiTheme.colors.textFaint)
                }
            }
        }
    }
}

/** 思考块：默认折叠（§4.4），点开可见。 */
@Composable
private fun ThinkingBlockRow(block: MessageBlock, key: String) {
    var expanded by remember(key) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { expanded = !expanded }
                .padding(vertical = 3.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (expanded) "▾ 思考过程" else "▸ 思考过程",
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
            )
        }
        if (expanded) {
            MessageText(block.text.orEmpty(), color = MpiTheme.colors.textDim)
        }
    }
}

/** 图片块渲染属 M4（图片输入/渲染一起做）；这里只提示存在，避免静默丢失。 */
@Composable
private fun ImageBlockHint(block: MessageBlock) {
    Text(
        text = "［图片${block.mimeType?.let { " · $it" } ?: ""}（手机端渲染待 M4）］",
        style = MaterialTheme.typography.labelSmall,
        color = MpiTheme.colors.textFaint,
    )
}

@Composable
private fun CenteredHint(text: String, loading: Boolean = false) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            Spacer(Modifier.height(10.dp))
        }
        Text(text, style = MaterialTheme.typography.bodySmall, color = MpiTheme.colors.textDim)
    }
}
