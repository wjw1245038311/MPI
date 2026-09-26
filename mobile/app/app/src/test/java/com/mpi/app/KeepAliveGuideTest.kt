package com.mpi.app

import com.mpi.app.data.KeepAliveGuide
import com.mpi.app.data.KeepAliveGuide.Vendor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 后台保活引导的纯逻辑：厂商识别与设置页候选。
 *
 * 真机入口（`startActivity` / `PowerManager`）不在单测范围——这里只钉住「给哪家
 * ROM 试哪个入口」这张表，避免以后改动候选时悄悄把某家漏掉。
 */
class KeepAliveGuideTest {

    private fun vendor(manufacturer: String?, brand: String? = null) =
        KeepAliveGuide.vendorOf(manufacturer, brand)

    @Test
    fun `matches mainstream vendors case insensitively`() {
        assertEquals(Vendor.XIAOMI, vendor("Xiaomi"))
        assertEquals(Vendor.XIAOMI, vendor("Redmi"))
        assertEquals(Vendor.XIAOMI, vendor("unknown", "POCO"))
        assertEquals(Vendor.HUAWEI, vendor("HUAWEI"))
        assertEquals(Vendor.HUAWEI, vendor("unknown", "HONOR"))
        assertEquals(Vendor.ONEPLUS, vendor("OnePlus"))
        assertEquals(Vendor.OPPO, vendor("OPPO"))
        assertEquals(Vendor.OPPO, vendor("unknown", "realme"))
        assertEquals(Vendor.VIVO, vendor("vivo"))
        assertEquals(Vendor.VIVO, vendor("unknown", "iQOO"))
        assertEquals(Vendor.MEIZU, vendor("Meizu"))
        assertEquals(Vendor.LETV, vendor("Letv"))
    }

    @Test
    fun `oneplus wins over oppo since it used to brand as oppo`() {
        // 一加机器历史上 MANUFACTURER=OnePlus、BRAND=OnePlus，但部分 ROM 带 oppo 字样；
        // 候选表里一加与 OPPO 不同，先判一加才不会跳到 OPPO 的页面。
        assertEquals(Vendor.ONEPLUS, vendor("OnePlus", "OnePlus"))
    }

    @Test
    fun `unknown vendors get no candidates`() {
        assertEquals(Vendor.OTHER, vendor("Samsung"))
        assertEquals(Vendor.OTHER, vendor(null, null))
        assertEquals(Vendor.OTHER, vendor(""))
        assertTrue(KeepAliveGuide.vendorSettingCandidates(Vendor.OTHER).isEmpty())
    }

    @Test
    fun `every vendor gets a concrete hint that names the app`() {
        for (v in Vendor.values()) {
            val hint = KeepAliveGuide.vendorHint(v)
            assertTrue("$v 必须有提示文案", hint.isNotBlank())
            assertTrue("$v 的提示要点名 MPI，否则用户不知道给谁设置", hint.contains("MPI"))
        }
        // 华为真机上真正的开关叫「自动管理」——按「自启动」字面找是找不到的（2026-09-26 踩过）
        assertTrue(
            "华为提示必须点出「自动管理」",
            KeepAliveGuide.vendorHint(Vendor.HUAWEI).contains("自动管理"),
        )
    }

    @Test
    fun `every known vendor ships at least one parsable candidate`() {
        for (v in Vendor.values()) {
            val candidates = KeepAliveGuide.vendorSettingCandidates(v)
            if (v == Vendor.OTHER) {
                assertTrue("OTHER 不应有候选", candidates.isEmpty())
                continue
            }
            assertTrue("$v 至少一个候选", candidates.isNotEmpty())
            for (spec in candidates) {
                val parts = spec.split("/")
                assertEquals("$spec 必须是 pkg/cls", 2, parts.size)
                assertTrue("$spec 包名非空", parts[0].isNotBlank())
                assertTrue("$spec 类名非空", parts[1].isNotBlank())
            }
        }
    }
}
