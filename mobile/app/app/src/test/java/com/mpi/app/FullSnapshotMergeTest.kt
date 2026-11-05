package com.mpi.app

import com.mpi.app.data.mergeFull
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.ThreadMessage
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 全量快照的合并（纯函数）：历史以主机为准，但**本地还没被主机确认的乐观消息不能丢**。
 *
 * 背景（2026-11-05 真机）：回合进行中带图片发送会走 followUp 排队，那条消息要等当前回合
 * 结束才落盘进历史；这段窗口里任何一次全量快照（重连 / seq 缺口 / 媒体补拉 / 缓存对齐）
 * 都会把乐观气泡整条替掉，用户看到的就是「消息和图片一起凭空消失」。
 */
class FullSnapshotMergeTest {

    private fun text(id: String, role: String = "assistant", body: String = "x", pending: Boolean = false) =
        ThreadMessage(
            id = id,
            role = role,
            pending = pending,
            blocks = listOf(MessageBlock(type = BlockType.Text, text = body)),
        )

    private fun imageUser(id: String, body: String? = null, pending: Boolean = false): ThreadMessage {
        val blocks = buildList {
            if (body != null) add(MessageBlock(type = BlockType.Text, text = body))
            add(MessageBlock(type = BlockType.Image, data = "AAAA"))
        }
        return ThreadMessage(id = id, role = "user", pending = pending, blocks = blocks)
    }

    private fun ids(list: List<ThreadMessage>) = list.map { it.id }

    @Test
    fun `keeps the optimistic message the host has not seen yet`() {
        val local = listOf(
            text("user-100", role = "user", body = "问"),
            text("assistant-200", body = "答"),
            imageUser("u-local-1", body = "这图怎么改", pending = true),
        )
        val incoming = listOf(
            text("user-100", role = "user", body = "问"),
            text("assistant-200", body = "答"),
        )
        val merged = mergeFull(local, incoming)
        assertEquals(listOf("user-100", "assistant-200", "u-local-1"), ids(merged))
        assertEquals(true, merged.last().pending)
    }

    @Test
    fun `drops the optimistic copy once the host has echoed it`() {
        // 主机已经把它写进历史（id 换成 user-<ts>，内容相同）→ 不能再留一份，否则两个气泡
        val local = listOf(imageUser("u-local-1", body = "这图怎么改", pending = true))
        val incoming = listOf(
            text("user-100", role = "user", body = "问"),
            imageUser("user-300", body = "这图怎么改"),
        )
        assertEquals(listOf("user-100", "user-300"), ids(mergeFull(local, incoming)))
    }

    @Test
    fun `image-only optimistic message is not duplicated either`() {
        // 纯图片（没有文本）也要按「文本 + 媒体块数」的签名对账
        val local = listOf(imageUser("u-local-1", pending = true))
        val incoming = listOf(imageUser("user-300"))
        assertEquals(listOf("user-300"), ids(mergeFull(local, incoming)))
    }

    @Test
    fun `repeated identical sends only drop as many as the host echoed`() {
        // 用户连发两条一模一样的，主机历史里只多了一条 → 只抵掉一条占位。
        // 抵掉的是**先发**的那条（消息按序投递，先发的更可能已被主机接收），留下更新的那条。
        val local = listOf(
            text("user-100", role = "user", body = "好"),
            text("u-local-1", role = "user", body = "好", pending = true),
            text("u-local-2", role = "user", body = "好", pending = true),
        )
        val incoming = listOf(text("user-100", role = "user", body = "好"))
        assertEquals(listOf("user-100", "u-local-2"), ids(mergeFull(local, incoming)))
    }

    @Test
    fun `no pending messages means the host snapshot wins verbatim`() {
        val local = listOf(text("a-old", body = "旧"))
        val incoming = listOf(text("user-100", role = "user", body = "问"))
        assertEquals(incoming, mergeFull(local, incoming))
    }

    @Test
    fun `assistant placeholders are never resurrected`() {
        // 只有 user 的乐观回显要保留：assistant 半条属于流式气泡（streaming），不在这条路径上
        val local = listOf(text("a-local-1", body = "半条", pending = true))
        val incoming = listOf(text("user-100", role = "user", body = "问"))
        assertEquals(listOf("user-100"), ids(mergeFull(local, incoming)))
    }
}
