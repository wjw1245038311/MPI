package com.mpi.app

import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.ContextUsage
import com.mpi.app.protocol.ModelOption
import com.mpi.app.protocol.ModelRef
import com.mpi.app.protocol.TaskModeOption
import com.mpi.app.ui.ContextBand
import com.mpi.app.ui.bandOfPercent
import com.mpi.app.ui.formatTokens
import com.mpi.app.ui.modelChipLabel
import com.mpi.app.ui.readContextUsage
import com.mpi.app.ui.taskModeChipLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M2-5：会话配置 chip 行与上下文用量的显示口径（纯函数）。
 *
 * 口径必须与桌面端 ring / PWA `lib/context-usage.ts` 一致——压缩后 pi 会把 tokens
 * 报成 null，回退写错就会显示 0%，用户以为窗口空了。
 */
class ThreadToolbarLogicTest {

    @Test
    fun `context bands use the 60 75 90 thresholds`() {
        assertEquals(ContextBand.Low, bandOfPercent(59.9))
        assertEquals(ContextBand.Warn, bandOfPercent(60.0))
        assertEquals(ContextBand.Mid, bandOfPercent(75.0))
        assertEquals(ContextBand.Hi, bandOfPercent(90.0))
        assertEquals(ContextBand.Hi, bandOfPercent(100.0))
    }

    @Test
    fun `unknown window shows nothing instead of zero percent`() {
        val reading = readContextUsage(ContextUsage(tokens = 1_000L, contextWindow = 0L))
        assertFalse(reading.hasValue)
        assertEquals(0.0, reading.percent, 0.0001)
    }

    @Test
    fun `after compaction estimatedTokens is the fallback`() {
        val reading = readContextUsage(
            ContextUsage(tokens = null, contextWindow = 200_000L, estimatedTokens = 50_000L),
        )
        assertTrue(reading.hasValue)
        assertTrue(reading.isEstimate)
        assertEquals(50_000L, reading.used)
        assertEquals(25.0, reading.percent, 0.0001)
        assertEquals(ContextBand.Low, reading.band)
    }

    @Test
    fun `pi percent wins over the computed value`() {
        val reading = readContextUsage(
            ContextUsage(tokens = 10_000L, contextWindow = 200_000L, percent = 88.0),
        )
        assertEquals(88.0, reading.percent, 0.0001)
        assertEquals(ContextBand.Mid, reading.band)
    }

    @Test
    fun `percent is clamped at 100`() {
        val reading = readContextUsage(ContextUsage(tokens = 500_000L, contextWindow = 200_000L))
        assertEquals(100.0, reading.percent, 0.0001)
    }

    @Test
    fun `token formatting matches pwa`() {
        assertEquals("880", formatTokens(880))
        assertEquals("4.2k", formatTokens(4_200))
        assertEquals("132k", formatTokens(132_400))
    }

    @Test
    fun `mode chip falls back to baseline then raw id`() {
        assertEquals("基线", taskModeChipLabel(ThreadView(threadId = "t")))
        val modes = listOf(TaskModeOption(id = "iterate", name = "迭代模式"))
        assertEquals(
            "迭代模式",
            taskModeChipLabel(ThreadView(threadId = "t", taskMode = "iterate", availableModes = modes)),
        )
        assertEquals("ghost", taskModeChipLabel(ThreadView(threadId = "t", taskMode = "ghost")))
    }

    @Test
    fun `model chip keeps the short name and truncates long ones`() {
        assertEquals("默认模型", modelChipLabel(ThreadView(threadId = "t")))
        val short = ThreadView(
            threadId = "t",
            model = ModelRef("p", "a/b"),
            availableModels = listOf(ModelOption(provider = "p", id = "a/b", name = "anthropic/claude-x")),
        )
        assertEquals("claude-x", modelChipLabel(short))
        val long = ThreadView(
            threadId = "t",
            model = ModelRef("p", "x"),
            availableModels = listOf(ModelOption(provider = "p", id = "x", name = "abcdefghijklmnopqrstuvwxyz")),
        )
        assertEquals("abcdefghijklmnopq…", modelChipLabel(long))
    }
}
