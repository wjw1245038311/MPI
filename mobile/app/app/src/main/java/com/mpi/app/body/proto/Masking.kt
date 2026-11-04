package com.mpi.app.body.proto

/**
 * 打码与敏感词：**送进模型之前**的最后一道处理（屏幕文字进模型等于外发，见设计文档 §7）。
 * 纯函数，可单测。
 */
object Masking {

    /** 银行卡/身份证这类长数字串：保头尾，中间抹掉。 */
    private val LONG_DIGITS = Regex("""(?<!\d)(\d[\d\s-]{10,30}\d)(?!\d)""")
    /** 中国大陆身份证：17 位数字 + 数字或 X。 */
    private val ID_CARD = Regex("""(?<![\dXx])(\d{6})(\d{8})(\d{3}[\dXx])(?![\dXx])""")
    /** 验证码形态：4–6 位独立数字（只在“验证码”上下文里用，避免误伤）。 */
    private const val CODE_CONTEXT = "验证码"
    private const val MAX_LABEL = 60
    private const val MAX_FULL = 300

    /**
     * 打码：卡号 → 前 4 + •••• + 后 4；身份证 → 前 6 + •••••••• + 后 2。
     * 只作用于 12 位以上的长数字串，日期、金额、时长不受影响。
     */
    fun mask(text: String): String {
        if (text.isEmpty()) return text
        var out = ID_CARD.replace(text) { m ->
            "${m.groupValues[1]}••••••••${m.groupValues[3].takeLast(2)}"
        }
        out = LONG_DIGITS.replace(out) { m ->
            val digits = m.groupValues[1].filter { it.isDigit() }
            if (digits.length < 12) m.groupValues[1]
            else "${digits.take(4)}••••${digits.takeLast(4)}"
        }
        return out
    }

    /** 验证码上下文：文本里出现「验证码」时，同行独立的 4–6 位数字也打码。 */
    fun maskVerificationCode(text: String): String {
        if (!text.contains(CODE_CONTEXT)) return text
        return Regex("""(?<!\d)\d{4,6}(?!\d)""").replace(text) { "••••" }
    }

    /** 标签截断：先打码，再压空白，再按字数截断。 */
    fun label(text: String): String =
        maskVerificationCode(mask(text)).replace(Regex("\\s+"), " ").trim().let {
            if (it.length <= MAX_LABEL) it else it.take(MAX_LABEL - 1) + "…"
        }

    /** 整行文字（不进模型头部渲染，供 collect 与记录）。 */
    fun fullText(text: String): String =
        maskVerificationCode(mask(text)).replace(Regex("\\s+"), " ").trim().let {
            if (it.length <= MAX_FULL) it else it.take(MAX_FULL - 1) + "…"
        }
}

/**
 * 敏感词：命中后元素打 `⚠`，动作需要先问人（不等于硬拒绝——硬拒绝看 [SafetyGate]）。
 * 覆盖「一旦点错就花钱/删数据/交出账号」的词。
 */
object SensitiveWords {

    private val WORDS = listOf(
        // 钱
        "支付", "付款", "转账", "汇款", "提现", "充值", "下单", "购买", "结算", "免密", "银行卡", "钱包",
        // 账号与凭据
        "密码", "验证码", "授权", "登录", "注销", "解绑", "退出登录", "实名",
        // 破坏性
        "删除", "清空", "清除数据", "格式化", "卸载", "恢复出厂", "重置",
        // 外发
        "发送", "分享", "转发", "发布", "提交",
    )

    /** 命中的第一个敏感词；没有则 null。 */
    fun hit(label: String): String? = WORDS.firstOrNull { label.contains(it) }

    /** 输入框/密码框是否属于「绝不代填」的那类。 */
    fun isSecretField(label: String, password: Boolean): Boolean =
        password || label.contains("密码") || label.contains("验证码") || label.contains("支付密码")
}
