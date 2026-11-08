package com.mpi.app.ui

/**
 * 「回合跑完了要不要出声念一句」的判定（纯函数，可单测）。
 *
 * 历史（两次教训，都在这个文件里）：
 *
 * 1. **2026-10-30 之前**：播报挂在**当前打开会话**的 `running→false` 回调上，且只念
 *    「手机发起」的回合。真机表现：锁屏 / 划走 / 没打开那条会话就一声不出。
 * 2. **2026-11 第一次修**：把播报挪进 `notifyFinishedTurns`（列表轮询），并**顺手沿用了
 *    通知的「飞书已读」口径**——加了一条「正在看这条会话就不念」。结果把前台场景也念没了
 *    （用户口径：我一直就是前台看着它念的）。这是本文件出现第二条规则的原因。
 *
 * 现在的口径（用户明确要求）：
 * **只要开着「完成后语音播报」，回合跑完就念** —— 前台看着也念、锁屏也念、电脑发起的也念。
 * 只有三种情况不念，都是「念了没有意义或有害」：
 * ① 设置里关掉了播报；
 * ② 语音对话模式（长按麦克风）正在跑——那套循环自己会播报回复，否则一句念两遍；
 * ③ 通话中（含微信 VoIP）——系统会把媒体流压掉，还可能漏进通话让对方听见。
 *
 * 为什么不再判「谁发起的回合」：用户口径是「跑完就叫我」，而「谁发起」对「要不要听结果」
 * 没有因果关系；旧规则还导致电脑上跑的活手机完全静默。
 */
internal object TurnSpeechLogic {

    /**
     * 判定一次「回合完成」要不要念。
     *
     * @param enabled 用户在设置里开着「完成后语音播报」。
     * @param voiceChatActive 语音对话模式正在跑（它会自己念，别重复）。
     * @param inCall 当前处于通话中（运营商通话或 VoIP）。
     * @param allowDuringCall 设置里开了「通话中也播报」。
     */
    fun decide(
        enabled: Boolean,
        voiceChatActive: Boolean,
        inCall: Boolean,
        allowDuringCall: Boolean,
    ): Decision = when {
        !enabled -> Decision(false, "跳过：设置里已关闭语音播报")
        voiceChatActive -> Decision(false, "跳过：语音对话模式自己会念")
        inCall && !allowDuringCall -> Decision(false, "跳过：通话中（未允许通话中播报）")
        else -> Decision(true, if (inCall) "已播报（通话中，可能听不到）" else "已播报")
    }

    /** 判定结果。[reason] 直接进诊断页 `lastTurnNotify`，别再让用户猜「为什么没念」。 */
    internal data class Decision(val speak: Boolean, val reason: String)
}
