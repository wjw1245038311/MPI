package com.mpi.app.body.proto

/**
 * 身体层的**纯数据结构**：不依赖任何 Android 类型，因此格式规则能在 JVM 单测里跑。
 * 与 `docs/PHONE-AGENT-PLAN.md` §2 对应。
 */

/** 屏幕矩形（像素，右/下为开区间，语义同 android.graphics.Rect）。 */
data class Box(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val centerX: Int get() = (left + right) / 2
    val centerY: Int get() = (top + bottom) / 2
    val isEmpty: Boolean get() = width <= 0 || height <= 0

    fun contains(x: Int, y: Int): Boolean = x >= left && x < right && y >= top && y < bottom

    fun intersect(other: Box): Box =
        Box(maxOf(left, other.left), maxOf(top, other.top), minOf(right, other.right), minOf(bottom, other.bottom))

    /** 垂直重叠占较矮者的比例：1.0 = 同一行。 */
    fun rowOverlap(other: Box): Double {
        val overlap = minOf(bottom, other.bottom) - maxOf(top, other.top)
        val shorter = minOf(height, other.height)
        return if (overlap <= 0 || shorter <= 0) 0.0 else overlap.toDouble() / shorter
    }

    override fun toString(): String = "$left,$top,$right,$bottom"
}

/** 可滚动节点当前允许的方向（来自 AccessibilityAction 列表）。 */
object ScrollBits {
    const val FORWARD = 1
    const val BACKWARD = 2
    const val UP = 4
    const val DOWN = 8
    const val LEFT = 16
    const val RIGHT = 32
}

/** 一个无障碍节点（采集后的纯数据副本）。 */
data class UiNode(
    val className: String = "",
    val text: String? = null,
    val desc: String? = null,
    val hint: String? = null,
    val viewId: String? = null,
    val bounds: Box = Box(0, 0, 0, 0),
    val clickable: Boolean = false,
    val longClickable: Boolean = false,
    val editable: Boolean = false,
    val scrollable: Boolean = false,
    val checkable: Boolean = false,
    val checked: Boolean = false,
    val enabled: Boolean = true,
    val password: Boolean = false,
    /** `ScrollBits` 位掩码。 */
    val scroll: Int = 0,
    val horizontal: Boolean = false,
    /** Chromium 的 chromeRole / Compose 的 role（小写）。 */
    val roleHint: String? = null,
    /** API 30 的 stateDescription。 */
    val stateDesc: String? = null,
    val children: List<UiNode> = emptyList(),
)

enum class WindowKind { APP, SYSTEM }

/** 一个窗口；[ScreenInput.windows] 里**最后一个**是主窗口，前面的是弹窗。 */
data class UiWindow(
    val id: Int,
    val kind: WindowKind,
    val packageName: String?,
    val title: String?,
    val bounds: Box,
    val root: UiNode?,
)

/** 一次采集的输入。 */
class ScreenInput(
    val screenId: String,
    val appLabel: String?,
    val packageName: String?,
    val width: Int,
    val height: Int,
    val keyboardShown: Boolean?,
    /** 最后一个为主窗口，其余按弹窗渲染。 */
    val windows: List<UiWindow>,
    val detail: Boolean = false,
    /** 上一次同一 App 快照的元素 key，用于打 `+`；null = 不打标。 */
    val previousKeys: Set<String>? = null,
    /** 头部额外说明（受保护页面、安全窗口……）。 */
    val notes: List<String> = emptyList(),
    /** 前台窗口完全没有内容（多半被系统过滤）：不等于树质量差。 */
    val unreadable: Boolean = false,
    val charBudget: Int = 3000,
)

enum class ElementKind { ITEM, INPUT, LIST }

/**
 * 快照里的一个可操作元素。
 *
 * `id` **只对本次快照有效**：动作必须带 `screen` 号，身体层据此判断过期。
 * `fingerprint` 在动作前复验（窗口 | 矩形 | 角色 | 标签），不符即 `STALE_SCREEN`。
 */
class ScreenElement(
    val id: Int,
    val windowId: Int,
    val packageName: String?,
    val kind: ElementKind,
    val role: String,
    /** 渲染后的标签（已打码、≤60 字）。输入框这里是它的名字，**绝不是内容**。 */
    val label: String,
    /** 未截断的整行文字（已打码，≤300），供 collect 与操作记录用。 */
    val fullText: String,
    val bounds: Box,
    val clickable: Boolean,
    val longClickable: Boolean,
    val editable: Boolean,
    val password: Boolean,
    val checkable: Boolean,
    val scroll: Int,
    val horizontal: Boolean,
    val viewId: String?,
    /** 命中敏感词时非空——界面会打 ⚠，动作需要先问人。 */
    val sensitiveWord: String?,
    val listId: Int?,
    val parentId: Int?,
    val fingerprint: String,
    val key: String,
    /** 相比上一次同 App 快照是新出现的。 */
    val isNew: Boolean,
)

class FormattedScreen(
    val text: String,
    val elements: List<ScreenElement>,
    /** 因字符预算被省略的元素数（文本里会写「…另有 N 项」）。 */
    val hidden: Int,
    /** 有任何文字/描述的节点数；过少说明树质量差。 */
    val textNodes: Int,
    val poorTree: Boolean,
    val keys: Set<String>,
)
