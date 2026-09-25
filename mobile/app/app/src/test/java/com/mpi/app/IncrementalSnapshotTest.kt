package com.mpi.app

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
        assertEquals(listOf("m1", "local-1", "m2"), ids(merged))
    }
}
