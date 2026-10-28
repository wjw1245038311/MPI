package com.mpi.app

import com.mpi.app.data.isHostMessageId
import com.mpi.app.data.pickAnchorId
import com.mpi.app.data.mergeIncremental
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.ThreadMessage
import org.junit.Assert.assertEquals
import org.junit.Test

/** 增量快照的合并（纯函数）：主机只回「锚点及其之后」，本地已有历史不能被丢。 */
class IncrementalSnapshotTest {

    private fun message(id: String, text: String, pending: Boolean = false) = ThreadMessage(
        id = id,
        role = "assistant",
        pending = pending,
        blocks = listOf(MessageBlock(type = BlockType.Text, text = text)),
    )

    private fun ids(list: List<ThreadMessage>) = list.map { it.id }

    @Test
    fun `appends new messages and keeps the local history`() {
        val local = listOf(message("m1", "一"), message("m2", "二"))
        val merged = mergeIncremental(local, listOf(message("m2", "二"), message("m3", "三")))
        assertEquals(listOf("m1", "m2", "m3"), ids(merged))
    }

    @Test
    fun `the same id takes the newest copy`() {
        // 锚点那条可能在主机侧又长完了/被收口 —— 不覆盖就会永远停在旧版本
        val local = listOf(message("m1", "写了一半"), message("m2", "二"))
        val merged = mergeIncremental(local, listOf(message("m2", "写完了")))
        assertEquals("写完了", merged.first { it.id == "m2" }.blocks.first().text)
        assertEquals(2, merged.size)
    }

    @Test
    fun `an empty delta changes nothing`() {
        val local = listOf(message("m1", "一"))
        assertEquals(local, mergeIncremental(local, emptyList()))
    }

    @Test
    fun `local optimistic placeholders survive the merge`() {
        val local = listOf(message("m1", "一"), message("local-1", "刚发的", pending = true))
        val merged = mergeIncremental(local, listOf(message("m1", "一"), message("m2", "二")))
        // 未确认的占位不丢，而且排在最末（它就是最近一条还没被主机确认的消息）。
        assertEquals(listOf("m1", "m2", "local-1"), ids(merged))
    }

    @Test
    fun `synthetic ids after the anchor are replaced by the host copy`() {
        // 事件里长出来的流式消息（`a-17`）/ 事件补的用户消息（`u-5-1`）id 是本地合成的，
        // 主机快照里没有；增量回来之后必须被同位置的主机版替掉，不能留重复气泡。
        val local = listOf(message("user-100", "问"), message("a-17", "答了一半"))
        val merged = mergeIncremental(local, listOf(message("user-100", "问"), message("assistant-200", "答完了")))
        assertEquals(listOf("user-100", "assistant-200"), ids(merged))
    }

    @Test
    fun `only host ids can be used as the incremental anchor`() {
        // 主机发的：可当锚点
        assertEquals(true, isHostMessageId("user-1793157932657"))
        assertEquals(true, isHostMessageId("assistant-1793157933159"))
        assertEquals(true, isHostMessageId("tool-call_abc"))
        // 本地合成的：拿去问 haveMessageId 必然 miss（本次修的 bug）
        assertEquals(false, isHostMessageId("local-1"))
        assertEquals(false, isHostMessageId("a-17"))
        assertEquals(false, isHostMessageId("u-17-3"))
        assertEquals(false, isHostMessageId(""))
    }

    @Test
    fun `the anchor is the last user message never the assistant bubbles`() {
        // 主机把一轮里连续的 assistant 条目折叠成一个回合（id 取第一条时间戳），
        // 客户端却是每条 message_end 一个气泡。拿最后一个气泡当锚点 → 主机 findIndex=-1
        // → 回全量（现场每次 618KB～1.6MB）。
        val turn = listOf(
            message("user-100", "问"),
            message("assistant-110", "答一"),
            message("assistant-120", "答二"),
        )
        assertEquals("user-100", pickAnchorId(turn))
        assertEquals(null, pickAnchorId(listOf(message("local-1", "刚发的", pending = true))))
        assertEquals(
            "user-100",
            pickAnchorId(turn + message("local-2", "刚发的", pending = true)),
        )
        assertEquals(null, pickAnchorId(emptyList()))
    }
}
