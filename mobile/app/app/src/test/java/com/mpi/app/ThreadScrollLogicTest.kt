package com.mpi.app

import com.mpi.app.ui.nextFollowing
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 会话流「贴底跟随」的决策（真机反馈：滚到底后新内容不跟手，要手动再拖）。
 *
 * 关键是跟随状态必须记**用户意图**，而不是每次按「当前是否贴底」重算——
 * 增量事件早于测量时会把滚动停在半路，按位置重算就永远为 false，再也跟不上。
 */
class ThreadScrollLogicTest {

    @Test
    fun `user scrolling back stops following`() {
        assertEquals(false, nextFollowing(current = true, scrolling = true, scrolledBackward = true, canScrollForward = true))
    }

    @Test
    fun `content growth alone never cancels following`() {
        // 内容增长：不在滚动、已有可滚动余量 → 意图不变
        assertEquals(true, nextFollowing(current = true, scrolling = false, scrolledBackward = false, canScrollForward = true))
    }

    @Test
    fun `reaching the very bottom resumes following`() {
        // 用户手动拖回最底（无余量）→ 恢复跟随，否则下一条增量还是不动
        assertEquals(true, nextFollowing(current = false, scrolling = true, scrolledBackward = false, canScrollForward = false))
        assertEquals(true, nextFollowing(current = false, scrolling = false, scrolledBackward = false, canScrollForward = false))
    }

    @Test
    fun `programmatic forward scroll keeps the intent`() {
        assertEquals(true, nextFollowing(current = true, scrolling = true, scrolledBackward = false, canScrollForward = true))
        assertEquals(false, nextFollowing(current = false, scrolling = true, scrolledBackward = false, canScrollForward = true))
    }
}
