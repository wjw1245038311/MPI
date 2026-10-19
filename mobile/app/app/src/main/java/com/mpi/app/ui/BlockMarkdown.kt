package com.mpi.app.ui

/**
 * 块级 markdown（安卓）：标题 / 无序与有序列表（支持嵌套）/ 引用 / GFM 表格 / 段落。
 *
 * 背景（2026-10-19 真机）：手机端正文只做了行内（粗体/代码/斜体），`## 标题`、`- 列表项`、
 * `| 表格 |` 仍是原样字符，而桌面端是真标题/列表/表格。这里补齐「块」，与 PWA 的
 * lib/block-md.ts 同构。
 *
 * 取舍：列表嵌套**按缩进深度**表示（2 空格 = 1 级，最多 4 级）；表格只认 GFM 两行式；
 * 其余一律普通段落（Text 保留换行），不引 markdown 依赖。
 */
internal data class MdListItem(val text: String, val depth: Int = 0)

internal sealed interface MdBlock {
    data class Para(val text: String) : MdBlock
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Bullets(val items: List<MdListItem>) : MdBlock
    data class Ordered(val items: List<MdListItem>, val start: Int) : MdBlock
    data class Quote(val text: String) : MdBlock
    /** 对齐：每列 "left"/"center"/"right" 或 null（不指定）。 */
    data class Table(val header: List<String>, val align: List<String?>, val rows: List<List<String>>) : MdBlock
}

private val HEADING_RE = Regex("""^(#{1,6})\s+(.*)$""")
private val UL_ITEM_RE = Regex("""^[-*+]\s+(.*)$""")
private val OL_ITEM_RE = Regex("""^(\d{1,3})[.)]\s+(.*)$""")
private val QUOTE_RE = Regex("""^>\s?(.*)$""")
private val LIST_CONTINUATION_RE = Regex("""^\s{2,}\S""")
private val TABLE_SEPARATOR_RE = Regex("""^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$""")

/** 行首缩进 → 嵌套深度（2 空格一级，最多 4 级）。 */
private fun depthOf(line: String): Int {
    val spaces = line.takeWhile { it == ' ' || it == '\t' }.replace("\t", "  ").length
    return minOf(4, spaces / 2)
}

/** `| a | b |` → ["a","b"]；`\|` 转义的竖线保留在单元格里。 */
internal fun splitTableRow(line: String): List<String> {
    var text = line.trim()
    if (text.startsWith("|")) text = text.substring(1)
    if (text.endsWith("|")) text = text.dropLast(1)
    val cells = mutableListOf<String>()
    val current = StringBuilder()
    var i = 0
    while (i < text.length) {
        val ch = text[i]
        if (ch == '\\' && i + 1 < text.length && text[i + 1] == '|') {
            current.append('|'); i += 2; continue
        }
        if (ch == '|') {
            cells += current.toString().trim(); current.clear(); i++; continue
        }
        current.append(ch); i++
    }
    cells += current.toString().trim()
    return cells
}

private fun alignOf(separator: String): List<String?> = splitTableRow(separator).map { cell ->
    val left = cell.startsWith(":")
    val right = cell.endsWith(":")
    when {
        left && right -> "center"
        right -> "right"
        left -> "left"
        else -> null
    }
}

/** 把一段正文切成块。空文本返回空列表。 */
internal fun parseBlocks(text: String): List<MdBlock> {
    if (text.isBlank()) return emptyList()
    val lines = text.split('\n')
    val blocks = mutableListOf<MdBlock>()
    var para = mutableListOf<String>()
    var bullets: MutableList<MdListItem>? = null
    var ordered: MutableList<MdListItem>? = null
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
    fun flushAll() { flushPara(); flushLists(); flushQuote() }

    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val trimmed = line.trim()
        if (trimmed.isEmpty()) { flushAll(); i++; continue }

        // 表格：当前行以 | 开头，且下一行是分隔行
        if (trimmed.startsWith("|") && i + 1 < lines.size && TABLE_SEPARATOR_RE.matches(lines[i + 1].trim())) {
            val header = splitTableRow(trimmed)
            val align = alignOf(lines[i + 1].trim())
            val rows = mutableListOf<List<String>>()
            i += 2
            while (i < lines.size && lines[i].trim().startsWith("|")) {
                rows += splitTableRow(lines[i].trim())
                i++
            }
            if (header.isNotEmpty()) {
                flushAll()
                blocks += MdBlock.Table(header, align, rows)
                continue
            }
            i-- // 回退一格（与 PWA 的 for 循环语义一致）
        }

        val heading = HEADING_RE.matchEntire(trimmed)
        if (heading != null) {
            flushAll()
            blocks += MdBlock.Heading(heading.groupValues[1].length, heading.groupValues[2].trim())
            i++; continue
        }

        val quoteMatch = QUOTE_RE.matchEntire(trimmed)
        if (quoteMatch != null) {
            flushPara(); flushLists()
            if (quote == null) quote = mutableListOf()
            quote!!.add(quoteMatch.groupValues[1])
            i++; continue
        }

        val ul = UL_ITEM_RE.matchEntire(trimmed)
        if (ul != null) {
            flushPara(); flushQuote()
            val item = MdListItem(ul.groupValues[1].trim(), depthOf(line))
            if (bullets == null || ordered != null) { flushLists(); bullets = mutableListOf() }
            bullets!!.add(item)
            i++; continue
        }

        val ol = OL_ITEM_RE.matchEntire(trimmed)
        if (ol != null) {
            flushPara(); flushQuote()
            if (ordered == null || bullets != null) {
                flushLists()
                ordered = mutableListOf()
                orderedStart = ol.groupValues[1].toIntOrNull() ?: 1
            }
            ordered!!.add(MdListItem(ol.groupValues[2].trim(), depthOf(line)))
            i++; continue
        }

        // 列表项续行（缩进但不是新条目）并入上一项
        if (LIST_CONTINUATION_RE.containsMatchIn(line) && (bullets != null || ordered != null)) {
            val target = ordered ?: bullets!!
            target[target.size - 1] = target.last().copy(text = target.last().text + "\n" + trimmed)
            i++; continue
        }

        if (quote != null) { quote!!.add(trimmed); i++; continue }

        flushLists(); flushQuote()
        para.add(line)
        i++
    }
    flushAll()
    return blocks
}
