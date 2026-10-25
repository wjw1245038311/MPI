package com.mpi.app

import com.mpi.app.ui.handoffPhaseLabel
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 交接进度文案（纯函数）。
 *
 * 背景：交接一次要十几秒到一分钟（生成交接文档是整轮模型调用），而手机端原先只在
 * 点击后把按钮改成「交接中…」，用户分不清「在等」还是「挂了」（2026-10-26 反馈）。
 * 主机现在按阶段推 `handoff_progress`，这里钉住每个阶段的文案，避免某天把
 * 某个阶段漏成空字符串——那等于又回到黑箱等待。
 */
class HandoffProgressTest {

    @Test
    fun `every phase has a plain-language label`() {
        assertEquals("正在生成交接文档（最慢的一步）", handoffPhaseLabel("doc"))
        assertEquals("正在新建会话", handoffPhaseLabel("create"))
        assertEquals("正在继承模型 / 任务模式 / 权限", handoffPhaseLabel("config"))
        assertEquals("正在发出首条提示词", handoffPhaseLabel("prompt"))
        assertEquals("已完成，正在打开新会话", handoffPhaseLabel("done"))
        assertEquals("交接失败", handoffPhaseLabel("error"))
    }

    @Test
    fun `unknown or missing phase still says something`() {
        // null = 主机第一个进度事件还没到（中继往返期间），不能显示空白。
        assertEquals("正在通知主机…", handoffPhaseLabel(null))
        assertEquals("正在交接…", handoffPhaseLabel("something-new"))
    }
}
