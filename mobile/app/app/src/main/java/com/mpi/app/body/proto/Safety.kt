package com.mpi.app.body.proto

/**
 * 安全闸：**唯一**决定「这个动作能不能做」的地方（设计文档 §2）。
 *
 * 两类规则要分清：
 *  - **硬拒绝**：自身 App、名单里的应用、系统设置页、密码/验证码框。就算确认模式是
 *    `NEVER` 也不做，必须由用户逐项「解除限制」。
 *  - **要确认**：敏感词、名单里的「每步确认」应用、`NEVER` 之外的确认模式。
 *
 * 纯函数 + 显式策略参数，方便单测把每条规则钉住。
 */
enum class ConfirmMode {
    /** 每次都询问（默认）：写操作都要先问。 */
    ASK,
    /** 本任务免确认：每个任务只问一次（由上层记任务状态）。 */
    TASK_ONCE,
    /** 始终免确认：直接做（硬拒绝仍然有效）。 */
    NEVER,
}

/** 用户逐项抬起的硬规则；默认全关。 */
data class Unlocks(
    /** 系统设置、权限页、安装器、通知栏。 */
    val systemPages: Boolean = false,
    /** 密码、验证码、支付密码（填写的值永不进日志）。 */
    val secretFields: Boolean = false,
    /** MPI 自己的界面。 */
    val ownApp: Boolean = false,
)

enum class PolicyOp {
    /** 读屏、收集列表。 */
    READ,
    TAP,
    TYPE,
    SCROLL,
    KEY,
    /** 按截图坐标点击：每次都要确认。 */
    TAP_XY,
    /** 交给用户操作。 */
    HANDOFF,
    ;

    val isWrite: Boolean get() = this == TAP || this == TYPE || this == SCROLL || this == KEY || this == TAP_XY
}

/** 动作目标的最小信息（不依赖 Android 类型）。 */
data class PolicyTarget(
    val packageName: String?,
    val windowKind: WindowKind = WindowKind.APP,
    /** 元素标签（已打码）。 */
    val label: String = "",
    val password: Boolean = false,
    val sensitiveWord: String? = null,
)

sealed class Verdict {
    object Allow : Verdict()
    data class Ask(val reason: String) : Verdict()
    data class Deny(val reason: String) : Verdict()
}

data class SafetyPolicy(
    /** 既不能读也不能操作（支付、银行、券商…）。 */
    val denyPackages: List<String> = emptyList(),
    /** 读写都行，但每个写操作都要确认（微信之类）。 */
    val confirmEveryWritePackages: List<String> = emptyList(),
    val confirmMode: ConfirmMode = ConfirmMode.ASK,
    val unlocks: Unlocks = Unlocks(),
)

object SafetyGate {

    /** 出厂默认的「不碰」名单（按包名，机型无关的常见金融类）。 */
    val DEFAULT_DENY = listOf(
        "com.eg.android.AlipayGphone",
        "com.tencent.mm.plugin.wallet", // 微信支付入口在微信包内，靠敏感词与系统页兜底
        "com.unionpay",
        "com.chinamworld.main",
        "com.icbc",
        "com.ccb.longjiLife",
        "com.bankcomm.Bankcomm",
        "com.cmbchina.ccd.pluto.cmbActivity",
    )

    fun decide(
        op: PolicyOp,
        target: PolicyTarget,
        policy: SafetyPolicy,
        ownPackage: String?,
    ): Verdict {
        val pkg = target.packageName
        // 1) 自身界面
        if (ownPackage != null && pkg == ownPackage && !policy.unlocks.ownApp) {
            return Verdict.Deny("MPI 自己的界面由用户操作")
        }
        // 2) 名单：不碰
        if (pkg != null && policy.denyPackages.any { it == pkg }) {
            return Verdict.Deny("应用名单里这个应用是不碰")
        }
        // 3) 系统页面（读也不行：里面常有账号、权限、支付设置）
        if (target.windowKind == WindowKind.SYSTEM && !policy.unlocks.systemPages) {
            return Verdict.Deny("系统设置与权限页面需要用户操作")
        }
        // 4) 密码 / 验证码：绝不代填
        val secret = target.password || SensitiveWords.isSecretField(target.label, target.password)
        if (op == PolicyOp.TYPE && secret && !policy.unlocks.secretFields) {
            return Verdict.Deny("密码与验证码需要用户输入")
        }
        // 5) 坐标点击：没有语义兜底，每次都要问
        if (op == PolicyOp.TAP_XY) return Verdict.Ask("按坐标点击需要确认")
        // 6) 每步确认的应用
        if (op.isWrite && pkg != null && policy.confirmEveryWritePackages.any { it == pkg }) {
            return Verdict.Ask("这个应用每一步都要确认")
        }
        // 7) 敏感词
        if (op.isWrite && target.sensitiveWord != null) {
            return Verdict.Ask("敏感操作：${target.sensitiveWord}")
        }
        // 8) 确认模式
        return when {
            op == PolicyOp.HANDOFF -> Verdict.Allow
            !op.isWrite -> Verdict.Allow
            policy.confirmMode == ConfirmMode.NEVER -> Verdict.Allow
            policy.confirmMode == ConfirmMode.TASK_ONCE -> Verdict.Ask("本任务确认一次")
            else -> Verdict.Ask("确认方式：每次都询问")
        }
    }
}
