package com.mpi.app

import com.mpi.app.protocol.HostIdentityException
import com.mpi.app.protocol.checkHostIdentity
import com.mpi.app.protocol.createDeviceIdentity
import com.mpi.app.protocol.hostIdFor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * P0-1：主机身份绑定 + pinning（2026-10-19 审计，docs/SECURITY-AUDIT-2026-10-19-RELAY-MITM.md §2）。
 *
 * 钉住的规则：`hostId` 是主机身份公钥的哈希，来自**扫码**（带外通道）；中继递来的公钥必须能
 * 哈希回它，且已 pin 过的主机不得换公钥。否则中继可以拿自己的密钥对冒充主机、全程 MITM。
 *
 * 期望值由 PWA/Node 侧 `createDeviceIdentity(seed)` + `hostIdFor()` 生成（同一算法），
 * 两端不一致会在这里直接失败。
 */
class HostIdentityTest {

    /** 固定种子（32 字节 0x01）→ 确定性 Ed25519 身份。 */
    private val seed = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"

    private val expectedPem = """
        -----BEGIN PUBLIC KEY-----
        MCowBQYDK2VwAyEAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=
        -----END PUBLIC KEY-----
    """.trimIndent() + "\n"

    private val expectedHostId = "PUwDBTSxwcalI4v1ky1-S5eq"

    @Test
    fun `PEM 与 hostId 与 PWA 逐字节一致`() {
        val identity = createDeviceIdentity(seed)
        assertEquals(expectedPem, identity.publicKeyPem)
        assertEquals(expectedHostId, hostIdFor(identity.publicKeyPem))
    }

    @Test
    fun `公钥能哈希回票里的 hostId 时放行`() {
        checkHostIdentity(expectedHostId, expectedPem)
    }

    @Test
    fun `中继换身份公钥（hostId 照抄）必须拒绝`() {
        val attacker = createDeviceIdentity("AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI")
        assertNotEquals(expectedHostId, hostIdFor(attacker.publicKeyPem))
        try {
            checkHostIdentity(expectedHostId, attacker.publicKeyPem)
            fail("换公钥必须被拒")
        } catch (e: HostIdentityException) {
            assertEquals(true, e.message!!.contains("hostId"))
        }
    }

    @Test
    fun `已 pin 的主机换公钥必须拒绝`() {
        val other = createDeviceIdentity("AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI")
        try {
            checkHostIdentity(
                hostId = hostIdFor(other.publicKeyPem),
                hostPublicKeyPem = other.publicKeyPem,
                pinnedHostPublicKeyPem = expectedPem,
            )
            fail("pinned 后的公钥变化必须被拒")
        } catch (e: HostIdentityException) {
            assertEquals(true, e.message!!.contains("已变化"))
        }
    }

    @Test
    fun `票内公钥与对端不符必须拒绝`() {
        val other = createDeviceIdentity("AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI")
        try {
            checkHostIdentity(
                hostId = expectedHostId,
                hostPublicKeyPem = expectedPem,
                ticketHostPublicKeyPem = other.publicKeyPem,
            )
            fail("票内公钥与对端不符必须被拒")
        } catch (e: HostIdentityException) {
            assertEquals(true, e.message!!.contains("配对票"))
        }
    }

    @Test
    fun `旧票与旧记录（无 pin）仍可配对`() {
        // 只有 hostId、没有票内公钥、没有 pin —— 兼容升级前的记录，不能把人锁死在门外
        checkHostIdentity(expectedHostId, expectedPem, ticketHostPublicKeyPem = null, pinnedHostPublicKeyPem = null)
    }

    @Test
    fun `空公钥一律拒绝`() {
        try {
            checkHostIdentity(expectedHostId, "")
            fail("空公钥必须被拒（不允许验不了就放行）")
        } catch (e: HostIdentityException) {
            assertEquals(true, e.message!!.contains("缺少主机身份公钥"))
        }
    }
}
