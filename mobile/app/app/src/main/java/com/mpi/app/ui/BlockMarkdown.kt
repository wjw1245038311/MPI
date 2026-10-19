package com.mpi.app.ui

/**
 * 块级 markdown（安卓）：标题 / 无序列表 / 有序列表 / 引用。
 *
 * 背景（2026-10-19 真机）：手机端正文只做了行内（粗体/代码/斜体），`## 标题`、`- 列表项`
 * 仍是原样字符，而桌面端是真标题与列表。这里补齐「块」，与 PWA 的 lib/block-md.ts 同构。
 *
 * 只认最容易误伤的四类，其余一律普通段落（Compose 的 Text 保留换行）。
 */
internal sealed interface MdBlock {
    data class Para(val text: String) : MdBlock
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Bullets(val items: List<String>) : MdBlock
    data class Ordered(val items: List<String>, val start: Int) : MdBlock
    data class Quote(val text: String) : MdBlock
}

private val HEADING_RE = Regex("""^(#{1,6})\s+(.*)$""")
private val UL_ITEM_RE = Regex("""^[-*+]\s+(.*)$""")
private val OL_ITEM_RE = Regex("""^(\d{1,3})[.)]\s+(.*)$""")
private val QUOTE_RE = Regex("""^>\s?(.*)$""")
private val LIST_CONTINUATION_RE = Regex("""^\s{2,}\S""")

/** 把一段正文切成块。空文本返回空列表。 */
internal fun parseBlocks(text: String): List<MdBlock> {
    if (text.isBlank()) return emptyList()
    val blocks = mutableListOf<MdBlock>()
    var para = mutableListOf<String>()
    var bullets: MutableList<String>? = null
    var ordered: MutableList<String>? = null
    var orderedStart = 1
    var quote: MutableList<String>? = null

    fun flushPara() {
        if (para.isEmpty()) return
        val body = para.joinToString("\n")
        if (body.isNotBlank()) blocks += MdBlock.Para(body)
        para = mutableListOf()
    }
    fun flushLists() {
        bullets?.let { if (it.isNotEmpty()) blocks += MdBlock.Bullets(it.toList()) }
        ordered?.let { if (it.isNotEmpty()) blocks += MdBlock.Ordered(it.toList(), orderedStart) }
        bullets = null
        ordered = null
        orderedStart = 1
    }
    fun flushQuote() {
        quote?.let { if (it.isNotEmpty() && it.joinToString("\n").isNotBlank()) blocks += MdBlock.Quote(it.joinToString("\n")) }
        quote = null
    }
    fun flushAll() {
        flushPara(); flushLists(); flushQuote()
    }

    for (line in text.split('\n')) {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) { flushAll(); continue }

        val heading = HEADING_RE.matchEntire(trimmed)
        if (heading != null) {
            flushAll()
            blocks += MdBlock.Heading(heading.groupValues[1].length, heading.groupValues[2].trim())
            continue
        }

        val quoteMatch = QUOTE_RE.matchEntire(trimmed)
        if (quoteMatch != null) {
            flushPara(); flushLists()
            if (quote == null) quote = mutableListOf()
            quote!!.add(quoteMatch.groupValues[1])
            continue
        }

        val ul = UL_ITEM_RE.matchEntire(trimmed)
        if (ul != null) {
            flushPara(); flushQuote()
            if (bullets == null || ordered != null) { flushLists(); bullets = mutableListOf() }
            bullets!!.add(ul.groupValues[1].trim())
            continue
        }

        val ol = OL_ITEM_RE.matchEntire(trimmed)
        if (ol != null) {
            flushPara(); flushQuote()
            if (ordered == null || bullets != null) {
                flushLists()
                ordered = mutableListOf()
                orderedStart = ol.groupValues[1].toIntOrNull() ?: 1
            }
            ordered!!.add(ol.groupValues[2].trim())
            continue
        }

        // 列表项的续行（缩进 2+ 空格）算同一项，避免软换行被拆成多段
        if (LIST_CONTINUATION_RE.containsMatchIn(line) && (bullets != null || ordered != null)) {
            val target = ordered ?: bullets!!
            target[target.size - 1] = target.last() + "\n" + trimmed
            continue
        }

        if (quote != null) { quote!!.add(trimmed); continue }

        flushLists(); flushQuote()
        para.add(line)
    }
    flushAll()
    return blocks
}
