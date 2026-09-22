package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mpi.app.ui.theme.MpiTheme

/**
 * 长会话滚动基准页（M0-7，docs/MOBILE-NATIVE-DESIGN.md §2.5 证伪项 3）。
 *
 * 目的：验证 `LazyColumn` 在 2000 条消息下滚动能否维持 60fps（§1.5 预算 #4）。
 *
 * 为什么不用空列表测：真实的聊天列表里**文本换行**才是开销大头，
 * 所以这里刻意混入三种真实行形态（助手段落 / 用户气泡 / 折叠工具行），
 * 并且行结构、间距、圆角都按 §4.4 的设计来——换成空盒子测出的数字没有意义。
 *
 * 只由调试入口进入（`adb shell am start -n com.mpi.app/.MainActivity --ez benchmark true`），
 * 不参与正常启动路径。
 */
@Composable
fun BenchmarkScreen(itemCount: Int = DEFAULT_ITEM_COUNT, modifier: Modifier = Modifier) {
    val messages = remember(itemCount) { List(itemCount) { FakeMessage.of(it) } }
    val listState = rememberLazyListState()

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        state = listState,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 12.dp),
    ) {
        // 稳定 key：滚动时复用、避免整列重组（§1.5 风险 1 的对策）
        items(messages, key = { it.id }) { message ->
            when (message.kind) {
                MessageKind.Assistant -> AssistantRow(message)
                MessageKind.User -> UserRow(message)
                MessageKind.Tool -> ToolRow(message)
            }
        }
    }
}

private enum class MessageKind { Assistant, User, Tool }

private data class FakeMessage(
    val id: String,
    val kind: MessageKind,
    val text: String,
) {
    companion object {
        /** 固定文案池——避免随机数导致每次运行的可比性下降。 */
        private val assistantTexts = listOf(
            "我先看一下相关文件，确认登录流程里哪一步出了问题。",
            "已经定位到原因：会话过期时没有清理本地缓存，导致下次请求带着旧的 token 继续重试。" +
                "我准备改三处：请求前的过期判断、失败后的清理逻辑，以及对应的单元测试。",
            "改完了，测试也跑通了。这次改动影响面很小，只动了 auth 模块。",
        )

        private val userTexts = listOf(
            "帮我看下登录失败的问题",
            "这个报错是偶发的，一天大概两三次，你重点看下并发的情况",
            "可以，按你说的改",
        )

        fun of(index: Int): FakeMessage {
            // 每 5 条插一条折叠工具行——真实会话里工具调用就是这种密度
            val kind = when {
                index % 5 == 3 -> MessageKind.Tool
                index % 3 == 0 -> MessageKind.User
                else -> MessageKind.Assistant
            }
            val text = when (kind) {
                MessageKind.Assistant -> assistantTexts[index % assistantTexts.size]
                MessageKind.User -> userTexts[index % userTexts.size]
                MessageKind.Tool -> "读取 ${(index % 4) + 1} 个文件"
            }
            return FakeMessage(id = "msg-$index", kind = kind, text = text)
        }
    }
}

@Composable
private fun AssistantRow(message: FakeMessage) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier.size(28.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) {
            Text("M", color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.labelSmall)
        }
        Box(
            Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(MpiTheme.colors.surfaceMuted)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                text = message.text,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun UserRow(message: FakeMessage) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Box(
            Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(MpiTheme.colors.userBubble)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                text = message.text,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

/** 折叠工具行：单行 + 省略号，点击展开的能力在 M3 实现。 */
@Composable
private fun ToolRow(message: FakeMessage) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 42.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("▸", style = MaterialTheme.typography.bodySmall, color = MpiTheme.colors.textFaint)
        Text(
            text = message.text,
            style = MaterialTheme.typography.bodySmall,
            color = MpiTheme.colors.textDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

const val DEFAULT_ITEM_COUNT = 2000

/** 供 MainActivity 判断是否进入基准页的 intent extra。 */
const val EXTRA_BENCHMARK = "benchmark"
