package com.mpi.app.body

import android.view.accessibility.AccessibilityNodeInfo
import com.mpi.app.body.proto.Box
import com.mpi.app.body.proto.ScrollBits
import com.mpi.app.body.proto.UiNode
import com.mpi.app.body.proto.UiWindow
import com.mpi.app.body.proto.WindowKind

/**
 * AccessibilityNodeInfo 树 → 纯数据 [UiNode]（设计文档 §2「采集」）。
 *
 * 为什么要抄一份纯数据：格式规则（`ScreenText`）与安全闸（`SafetyGate`）在 JVM 单测里跑，
 * 不依赖真机；这里只做「搬运 + 限深限量」，不做任何渲染判断。
 */
object TreeCapture {

    /** 深度与节点数上限：防止畸形树把内存拖爆（超了就让 `poorTree` 去提示）。 */
    private const val MAX_DEPTH = 40
    private const val MAX_NODES = 2500

    fun capture(windows: List<AccessibilityNodeInfo>, screen: Box, keyboardShown: Boolean?): List<UiWindow> {
        var budget = MAX_NODES
        val out = ArrayList<UiWindow>()
        windows.forEachIndexed { index, root ->
            val bounds = Rect0.of(root)
            out += UiWindow(
                id = index,
                kind = kindOf(root.packageName?.toString()),
                packageName = root.packageName?.toString(),
                title = root.window?.title?.toString(),
                bounds = if (bounds.isEmpty) screen else bounds,
                root = convert(root, 0) { budget-- > 0 },
            )
        }
        return out
    }

    /** 包名 → 窗口类别（系统页面/普通应用）；调度器判安全策略时也用它。 */
    internal fun kindOf(pkg: String?): WindowKind { 
        val name = pkg.orEmpty()
        // SystemUI / 设置 / 权限控制器这类：安全闸一律不碰（除非用户解除限制）
        return if (name == "com.android.systemui" || name == "android" ||
            name.startsWith("com.android.settings") || name.startsWith("com.google.android.permissioncontroller")
        ) WindowKind.SYSTEM else WindowKind.APP
    }

    private fun convert(node: AccessibilityNodeInfo, depth: Int, take: () -> Boolean): UiNode? {
        if (depth > MAX_DEPTH || !take()) return null
        val children = ArrayList<UiNode>()
        for (i in 0 until node.childCount) {
            val child = runCatching { node.getChild(i) }.getOrNull() ?: continue
            convert(child, depth + 1, take)?.let { children += it }
        }
        return UiNode(
            className = node.className?.toString().orEmpty(),
            text = node.text?.toString(),
            desc = node.contentDescription?.toString(),
            hint = runCatching { node.hintText?.toString() }.getOrNull(),
            viewId = node.viewIdResourceName,
            bounds = Rect0.of(node),
            clickable = node.isClickable,
            longClickable = node.isLongClickable,
            editable = node.isEditable,
            scrollable = node.isScrollable,
            checkable = node.isCheckable,
            checked = node.isChecked,
            enabled = node.isEnabled,
            password = node.isPassword,
            scroll = scrollBits(node),
            horizontal = horizontalScroll(node),
            roleHint = runCatching {
                // Compose / Chromium 把角色写在 extras 里，不是独立属性
                node.extras?.getString("AccessibilityNodeInfo.roleDescription")?.lowercase()
            }.getOrNull(),
            stateDesc = runCatching { node.stateDescription?.toString() }.getOrNull(),
            children = children,
        )
    }

    /** 从 actionList 里读「现在能往哪滚」，比 isScrollable 精确。 */
    private fun scrollBits(node: AccessibilityNodeInfo): Int {
        if (!node.isScrollable) return 0
        var bits = 0
        for (action in node.actionList) {
            when (action.id) {
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD.id -> bits = bits or ScrollBits.FORWARD
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD.id -> bits = bits or ScrollBits.BACKWARD
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id -> bits = bits or ScrollBits.UP
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id -> bits = bits or ScrollBits.DOWN
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id -> bits = bits or ScrollBits.LEFT
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id -> bits = bits or ScrollBits.RIGHT
            }
        }
        // 老控件只给 forward/backward；能上下滚就默认按竖向处理
        if (bits == 0) bits = ScrollBits.FORWARD or ScrollBits.BACKWARD
        return bits
    }

    private fun horizontalScroll(node: AccessibilityNodeInfo): Boolean {
        val bits = scrollBits(node)
        return bits and (ScrollBits.LEFT or ScrollBits.RIGHT) != 0 && bits and (ScrollBits.UP or ScrollBits.DOWN) == 0
    }

    /** 按「矩形 + 标签」在最新树里找回同一个节点（动作前的复验入口）。 */
    fun findByBounds(
        roots: List<AccessibilityNodeInfo>,
        bounds: Box,
        label: String?,
    ): AccessibilityNodeInfo? {
        var found: AccessibilityNodeInfo? = null
        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (found != null || depth > MAX_DEPTH) return
            if (Rect0.of(node) == bounds) {
                val text = node.text?.toString() ?: node.contentDescription?.toString() ?: node.hintText?.toString()
                if (label.isNullOrEmpty() || text == null || text.contains(label) || label.contains(text)) {
                    found = node
                }
            }
            for (i in 0 until node.childCount) {
                val child = runCatching { node.getChild(i) }.getOrNull() ?: continue
                walk(child, depth + 1)
            }
        }
        roots.forEach { walk(it, 0) }
        return found
    }
}

/** Rect 转换的小工具（避免各处 new Rect）。 */
internal object Rect0 {
    fun of(node: AccessibilityNodeInfo): Box {
        val rect = android.graphics.Rect()
        runCatching { node.getBoundsInScreen(rect) }
        return Box(rect.left, rect.top, rect.right, rect.bottom)
    }
}
