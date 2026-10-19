package com.mpi.app

import com.mpi.app.ui.mergeRetractedText
import com.mpi.app.ui.queueTextsOf
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 「撤回已插入、尚未执行的插话」（2026-10-19，对照 PWA 的 `queue-retract.ts`）。
 *
 * pi 的 `thread.clearQueue` 只能**整队清空**、且只返回文本，所以客户端必须把文本回填
 * 到「待处理后续」卡片——这里的规则就是那次回填的契约。
 */
class QueueRetractTest {

    private fun cleared(steering: List<String>, followUp: List<String>): JsonObject =
        buildJsonObject {
            put("steering", buildJsonArray { steering.forEach { add(JsonPrimitive(it)) } })
            put("followUp", buildJsonArray { followUp.forEach { add(JsonPrimitive(it)) } })
        }

    @Test
    fun `响应解析按 steering 在前、followUp 在后`() {
        val texts = queueTextsOf(cleared(listOf("改口径：用 A 方案", "再加一句"), listOf("之后跑测试")))
        assertEquals(listOf("改口径：用 A 方案", "再加一句", "之后跑测试"), texts)
    }

    @Test
    fun `脏数据被过滤`() {
        val raw = Json.parseToJsonElement(
            """{"steering":["ok","  ",1,null],"followUp":"nope"}""",
        )
        assertEquals(listOf("ok"), queueTextsOf(raw))
        assertEquals(emptyList<String>(), queueTextsOf(null))
        assertEquals(emptyList<String>(), queueTextsOf(JsonPrimitive("nope")))
    }

    @Test
    fun `没有暂存内容时直接使用撤回文本`() {
        assertEquals("插话", mergeRetractedText(null, listOf("插话")))
        assertEquals("a\n\nb", mergeRetractedText("  ", listOf("a", "b")))
    }

    @Test
    fun `已有暂存内容时追加在后面`() {
        assertEquals("已有的\n\n插话", mergeRetractedText("已有的", listOf("插话")))
        assertEquals("已有的\n\n插话", mergeRetractedText("已有的\n", listOf(" 插话 ")))
    }

    @Test
    fun `什么都没撤回时不造空卡片`() {
        assertNull(mergeRetractedText(null, emptyList()))
        assertNull(mergeRetractedText("   ", emptyList()))
        assertEquals("已有的", mergeRetractedText("已有的", emptyList()))
    }
}
