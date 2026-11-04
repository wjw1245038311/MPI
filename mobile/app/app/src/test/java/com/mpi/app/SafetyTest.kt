package com.mpi.app

import com.mpi.app.body.proto.ConfirmMode
import com.mpi.app.body.proto.PolicyOp
import com.mpi.app.body.proto.PolicyTarget
import com.mpi.app.body.proto.SafetyGate
import com.mpi.app.body.proto.SafetyPolicy
import com.mpi.app.body.proto.Unlocks
import com.mpi.app.body.proto.Verdict
import com.mpi.app.body.proto.WindowKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 安全闸：每条硬拒绝与「要确认」都必须钉住。
 * 这里失败意味着 AI 能碰它不该碰的东西——比任何 UI 测试都重要。
 */
class SafetyTest {

    private val own = "com.mpi.app"

    private fun target(
        pkg: String? = "com.example",
        kind: WindowKind = WindowKind.APP,
        label: String = "发送",
        password: Boolean = false,
        sensitive: String? = null,
    ) = PolicyTarget(pkg, kind, label, password, sensitive)

    private fun decide(
        op: PolicyOp,
        t: PolicyTarget,
        policy: SafetyPolicy = SafetyPolicy(),
    ) = SafetyGate.decide(op, t, policy, own)

    @Test
    fun `own app is refused even when confirmations are off`() {
        val v = decide(PolicyOp.TAP, target(pkg = own), SafetyPolicy(confirmMode = ConfirmMode.NEVER))
        assertTrue(v is Verdict.Deny)
    }

    @Test
    fun `deny-listed packages are refused for both read and write`() {
        val policy = SafetyPolicy(denyPackages = listOf("com.eg.android.AlipayGphone"))
        val t = target(pkg = "com.eg.android.AlipayGphone")
        assertTrue(decide(PolicyOp.READ, t, policy) is Verdict.Deny)
        assertTrue(decide(PolicyOp.TAP, t, policy) is Verdict.Deny)
    }

    @Test
    fun `system windows need the unlock even for reading`() {
        val t = target(pkg = "com.android.settings", kind = WindowKind.SYSTEM)
        assertTrue(decide(PolicyOp.READ, t) is Verdict.Deny)
        assertTrue(
            decide(PolicyOp.READ, t, SafetyPolicy(unlocks = Unlocks(systemPages = true))) is Verdict.Allow,
        )
    }

    @Test
    fun `typing into password or verification fields is refused unless unlocked`() {
        assertTrue(decide(PolicyOp.TYPE, target(password = true)) is Verdict.Deny)
        assertTrue(decide(PolicyOp.TYPE, target(label = "验证码")) is Verdict.Deny)
        assertTrue(
            decide(PolicyOp.TYPE, target(password = true), SafetyPolicy(unlocks = Unlocks(secretFields = true)))
                is Verdict.Ask, // 解锁了硬拒绝，但仍受确认模式约束
        )
    }

    @Test
    fun `coordinate taps always ask`() {
        assertTrue(decide(PolicyOp.TAP_XY, target()) is Verdict.Ask)
        assertTrue(decide(PolicyOp.TAP_XY, target(), SafetyPolicy(confirmMode = ConfirmMode.NEVER)) is Verdict.Ask)
    }

    @Test
    fun `every-write packages and sensitive words ask, never deny`() {
        val policy = SafetyPolicy(confirmEveryWritePackages = listOf("com.tencent.mm"))
        assertTrue(decide(PolicyOp.TAP, target(pkg = "com.tencent.mm"), policy) is Verdict.Ask)
        assertTrue(decide(PolicyOp.TAP, target(sensitive = "支付")) is Verdict.Ask)
        // 读不受影响
        assertTrue(decide(PolicyOp.READ, target(sensitive = "支付")) is Verdict.Allow)
    }

    @Test
    fun `confirm mode governs ordinary writes`() {
        assertTrue(decide(PolicyOp.TAP, target()) is Verdict.Ask)
        assertTrue(
            decide(PolicyOp.TAP, target(), SafetyPolicy(confirmMode = ConfirmMode.TASK_ONCE)) is Verdict.Ask,
        )
        assertTrue(
            decide(PolicyOp.TAP, target(), SafetyPolicy(confirmMode = ConfirmMode.NEVER)) is Verdict.Allow,
        )
        // 读屏永远不用确认
        assertEquals(Verdict.Allow, decide(PolicyOp.READ, target()))
    }

    @Test
    fun `handoff is always allowed`() {
        assertEquals(Verdict.Allow, decide(PolicyOp.HANDOFF, target()))
    }
}
