package com.mpi.app.body.proto

/**
 * 把无障碍树渲染成模型读的**紧凑屏文本**（对应设计文档 §2）：
 *
 * ```
 * 屏幕 s1 · 微信 · 竖屏 · 键盘收起 · 共 12 项
 * 顶部
 *   [1] 按钮 返回
 *   [2] 输入框 搜索
 * 列表 [4] 可下滑
 *   [5] 文本 张三 · 你好
 *       [6] 按钮 发送
 * 底部
 *   [11] 标签 全部
 * ```
 *
 * 规则：
 *  - 一个「可交互或有文字」的节点渲染一行，纯布局节点折叠；
 *  - 标签取值顺序：text → contentDescription → hint → viewId 尾段，先打码再截断 60 字；
 *  - 可点击行会聚合其**非交互**子孙的文字（TalkBack 的朗读单元），这些子孙不再单独占行；
 *  - 按位置分区 顶部/中部/底部，可滚动容器缩进一级并单独标「列表」；
 *  - 字符预算默认 3000，超出写「…另有 N 项」；
 *  - `⚠` = 命中敏感词（动作要先问人），`+` = 相比上次快照新增；
 *  - **密码框永不渲染内容**。
 *
 * 纯 Kotlin（不碰 Android 类型），全部规则可在 JVM 单测里验证。
 */
object ScreenText {

    /** 有文字/描述的节点少于这个数，判为树质量差（多半被系统过滤）。 */
    const val POOR_TREE = 3
    private const val INDENT = "  "

    fun format(input: ScreenInput): FormattedScreen {
        val elements = ArrayList<ScreenElement>()
        val keys = LinkedHashSet<String>()
        var textNodes = 0
        var nextId = 1

        for (window in input.windows) {
            val root = window.root ?: continue

            /**
             * 返回「可被上层可点击行聚合的文字」。
             * @param inRow 当前是否在某个可点击行内部（此时非交互节点不再单独占行）
             */
            fun walk(node: UiNode, listId: Int?, parentId: Int?, inRow: Boolean): List<String> {
                val label = resolveLabel(node)
                if (label.isNotEmpty()) textNodes++
                val scrollable = node.scrollable && node.scroll != 0
                val interactive = node.clickable || node.longClickable || node.editable || scrollable || node.checkable

                // 行内的纯文字：交给上层聚合，自己不占行
                if (inRow && !interactive) {
                    val texts = ArrayList<String>()
                    if (label.isNotEmpty()) texts += label
                    for (child in node.children) texts += walk(child, listId, parentId, true)
                    return texts
                }

                val emit = interactive || label.isNotEmpty()
                val myId = if (emit) nextId++ else null
                val childListId = if (scrollable) myId ?: listId else listId
                val childInRow = node.clickable && !node.editable

                val childTexts = ArrayList<String>()
                for (child in node.children) {
                    childTexts += walk(child, childListId, myId ?: parentId, childInRow)
                }
                if (myId == null) return childTexts

                val aggregated = if (childInRow && label.isEmpty()) childTexts.joinToString(" · ") else ""
                val shown = if (label.isNotEmpty()) label else aggregated
                val role = roleOf(node, scrollable)
                val kind = when {
                    node.editable -> ElementKind.INPUT
                    scrollable -> ElementKind.LIST
                    else -> ElementKind.ITEM
                }
                val rawFull = listOfNotNull(node.text, node.desc, node.hint, aggregated.ifEmpty { null })
                    .joinToString(" ")
                val full = Masking.fullText(rawFull).ifEmpty { shown }
                val key = buildKey(window.id, role, shown, node.viewId)
                keys += key
                elements += ScreenElement(
                    id = myId,
                    windowId = window.id,
                    packageName = window.packageName,
                    kind = kind,
                    role = role,
                    label = shown,
                    fullText = full,
                    bounds = node.bounds,
                    clickable = node.clickable,
                    longClickable = node.longClickable,
                    editable = node.editable,
                    password = node.password,
                    checkable = node.checkable,
                    scroll = node.scroll,
                    horizontal = node.horizontal,
                    viewId = node.viewId,
                    sensitiveWord = SensitiveWords.hit(shown.ifEmpty { role }),
                    listId = childListId,
                    parentId = parentId,
                    fingerprint = fingerprintOf(window.id, node.bounds, role, shown),
                    key = key,
                    isNew = input.previousKeys != null && key !in input.previousKeys,
                )
                // 行自己已消费掉文字；非行元素把整行文字交上去，供更外层的行聚合
                return if (childInRow) emptyList() else listOf(full).filter { it.isNotEmpty() }
            }

            walk(root, null, null, false)
        }

        // ---- 渲染 ----
        val sb = StringBuilder()
        sb.append("屏幕 ").append(input.screenId)
        input.appLabel?.takeIf { it.isNotBlank() }?.let { sb.append(" · ").append(it) }
        sb.append(" · ").append(if (input.width > input.height) "横屏" else "竖屏")
        input.keyboardShown?.let { sb.append(" · 键盘").append(if (it) "弹出" else "收起") }
        sb.append(" · 共 ").append(elements.size).append(" 项\n")
        for (note in input.notes) sb.append("说明：").append(note).append('\n')
        if (input.unreadable) sb.append("这个屏读不到内容（可能是安全窗口或被系统过滤），需要用户接手。\n")

        val byId = elements.associateBy { it.id }
        var budget = input.charBudget - sb.length
        var zone = ""
        var hidden = 0
        for (el in elements) {
            val elZone = zoneOf(el.bounds, input.height)
            val indent = indentOf(el, byId)
            val line = buildString {
                append(indent).append('[').append(el.id).append("] ").append(el.role)
                if (el.label.isNotEmpty()) append(' ').append(el.label)
                if (el.sensitiveWord != null) append(" ⚠")
                if (el.isNew) append(" +")
            }
            val zoneHeader = if (elZone.isNotEmpty() && elZone != zone) elZone else null
            val cost = line.length + (zoneHeader?.let { it.length + 1 } ?: 0) + 1
            if (cost > budget) {
                hidden++
                continue
            }
            if (zoneHeader != null) {
                sb.append(zoneHeader).append('\n')
                zone = elZone
            }
            sb.append(line).append('\n')
            budget -= cost
        }
        if (hidden > 0) sb.append("…另有 ").append(hidden).append(" 项\n")

        return FormattedScreen(
            text = sb.toString().trimEnd(),
            elements = elements,
            hidden = hidden,
            textNodes = textNodes,
            poorTree = textNodes < POOR_TREE && !input.unreadable,
            keys = keys,
        )
    }

    /** 渲染缩进：落在可滚动容器里的元素缩进一级。 */
    private fun indentOf(el: ScreenElement, byId: Map<Int, ScreenElement>): String {
        if (el.listId == null) return ""
        var depth = 1
        var cursor = byId[el.listId]
        var guard = 0
        while (cursor != null && guard < 3) {
            if (cursor.listId == null) break
            depth++
            cursor = byId[cursor.listId]
            guard++
        }
        return INDENT.repeat(depth.coerceIn(0, 3))
    }

    private fun zoneOf(bounds: Box, screenHeight: Int): String {
        if (screenHeight <= 0) return ""
        return when {
            bounds.top < screenHeight * 0.25 -> "顶部"
            bounds.top > screenHeight * 0.75 -> "底部"
            else -> "中部"
        }
    }

    /** 标签取值：text → desc → hint → viewId 尾段；密码框只给名字，不给内容。 */
    private fun resolveLabel(node: UiNode): String {
        if (node.password) {
            val name = Masking.label(listOfNotNull(node.hint, node.desc, viewIdTail(node.viewId)).firstOrNull() ?: "")
            return if (name.isEmpty()) "密码框" else name
        }
        val raw = node.text?.takeIf { it.isNotBlank() }
            ?: node.desc?.takeIf { it.isNotBlank() }
            ?: node.hint?.takeIf { it.isNotBlank() }
            ?: viewIdTail(node.viewId)
            ?: return ""
        return Masking.label(raw)
    }

    private fun viewIdTail(viewId: String?): String? {
        val tail = viewId?.substringAfterLast('/')?.trim() ?: return null
        if (tail.isEmpty() || tail.length !in 2..40) return null
        if (tail.matches(Regex("(?i).*(layout|container|root|view|widget|frame)\\d*"))) return null
        return tail
    }

    private fun roleOf(node: UiNode, scrollable: Boolean): String = when {
        node.editable -> "输入框"
        scrollable -> "列表"
        node.roleHint == "link" -> "链接"
        node.checkable -> if (node.checked) "选项·已选" else "选项"
        node.clickable || node.longClickable -> "按钮"
        else -> "文本"
    }

    private fun buildKey(windowId: Int, role: String, label: String, viewId: String?): String =
        "$windowId|$role|${viewId ?: ""}|$label"

    /** 动作前复验：窗口 | 矩形 | 角色 | 标签（任何一项变了都视为过期）。 */
    fun fingerprintOf(windowId: Int, bounds: Box, role: String, label: String): String =
        "$windowId|$bounds|$role|$label"

    /** 校验一次动作请求携带的 fingerprint 是否仍与当前屏一致。 */
    fun matches(el: ScreenElement, fingerprint: String?): Boolean =
        fingerprint == null || el.fingerprint == fingerprint
}
