package com.mpi.app

import com.mpi.app.protocol.RemotePermission
import com.mpi.app.protocol.RemoteThreadState
import com.mpi.app.protocol.RemoteThreadSummary
import com.mpi.app.ui.dayBucketLabel
import com.mpi.app.ui.drawerDayGroups
import com.mpi.app.ui.projectRowHint
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Calendar

/** 批 4：抽屉会话的时间分组（纯函数）。 */
class AppDrawerTest {

    private fun thread(id: String, updatedAt: Long) = RemoteThreadSummary(
        id = id,
        projectId = "p",
        title = id,
        preview = "",
        updatedAt = updatedAt,
        messageCount = 0,
        state = RemoteThreadState.Idle,
        permission = RemotePermission.Sandbox,
    )

    /** 取某个基准日的正午，避免测试跑在午夜边界时抖动。 */
    private fun noon(offsetDays: Int): Long {
        val cal = Calendar.getInstance()
        cal.add(Calendar.DAY_OF_YEAR, offsetDays)
        cal.set(Calendar.HOUR_OF_DAY, 12)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis
    }

    @Test
    fun `project row hint matches the PWA wording`() {
        val now = noon(0)
        assertEquals("11 会话 · 刚刚", projectRowHint(11, now - 30_000, now))
        assertEquals("3 会话 · 1 小时前", projectRowHint(3, now - 3_600_000, now))
    }

    @Test
    fun `the three buckets fall on local calendar days`() {
        val now = noon(0)
        assertEquals("今天", dayBucketLabel(noon(0), now))
        assertEquals("昨天", dayBucketLabel(noon(-1), now))
        assertEquals("更早", dayBucketLabel(noon(-2), now))
    }

    @Test
    fun `crossing midnight does not mislabel yesterday as today`() {
        val cal = Calendar.getInstance()
        cal.add(Calendar.DAY_OF_YEAR, -1)
        cal.set(Calendar.HOUR_OF_DAY, 23)
        cal.set(Calendar.MINUTE, 59)
        val lateYesterday = cal.timeInMillis
        val now = noon(0)

        assertEquals("昨天", dayBucketLabel(lateYesterday, now))
    }

    @Test
    fun `groups are ordered and sorted newest first`() {
        val now = noon(0)
        val groups = drawerDayGroups(
            listOf(
                thread("old", noon(-5)),
                thread("today-early", noon(0) - 3 * 3600_000L),
                thread("yesterday", noon(-1)),
                thread("today-late", noon(0) + 3 * 3600_000L),
            ),
            now,
        )
        assertEquals(listOf("今天", "昨天", "更早"), groups.map { it.first })
        assertEquals(listOf("today-late", "today-early"), groups[0].second.map { it.id })
        assertEquals(listOf("yesterday"), groups[1].second.map { it.id })
        assertEquals(listOf("old"), groups[2].second.map { it.id })
    }

    @Test
    fun `empty buckets are omitted`() {
        val now = noon(0)
        val groups = drawerDayGroups(listOf(thread("only", noon(0))), now)
        assertEquals(1, groups.size)
        assertEquals("今天", groups.single().first)
    }
}
