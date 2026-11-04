package com.mpi.app.body

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.accessibility.AccessibilityNodeInfo
import com.mpi.app.body.proto.Box
import com.mpi.app.body.proto.ScrollBits
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 动作执行：**三级退化**（设计文档 §2「动作」）。
 *
 * 1. 节点自己的 `ACTION_CLICK` / `ACTION_LONG_CLICK`；
 * 2. 最近的可点祖先（≤4 层，且祖先矩形含本节点中心）——手指落在那里也命中它；
 * 3. 手势注入（`dispatchGesture`），坐标取「矩形与屏幕的交集」的中心，
 *    并避开状态栏与底部手势条。
 *
 * 只做动作，不做策略：能不能做由 [com.mpi.app.body.proto.SafetyGate] 先判。
 */
class Actuator(private val service: AccessibilityService) {

    enum class Via { NODE, ANCESTOR, GESTURE }

    data class Outcome(val accepted: Boolean, val via: Via?)

    private val gestureThread = HandlerThread("mpi-body-gesture").apply { start() }
    private val gestureHandler = Handler(gestureThread.looper)

    fun close() {
        runCatching { gestureThread.quitSafely() }
    }

    fun click(node: AccessibilityNodeInfo?, bounds: Box, screen: Box, long: Boolean): Outcome {
        val action = if (long) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK
        fun able(n: AccessibilityNodeInfo): Boolean =
            n.isEnabled && if (long) n.isLongClickable else n.isClickable

        if (node != null && able(node) && node.performAction(action)) return Outcome(true, Via.NODE)

        // 文字在可点击的行里：手指点在文字上，命中的是行
        var parent = runCatching { node?.parent }.getOrNull()
        var depth = 0
        val rect = Rect()
        while (parent != null && depth < 4) {
            runCatching { parent!!.getBoundsInScreen(rect) }
            if (able(parent) && rect.contains(bounds.centerX, bounds.centerY)) {
                if (parent.performAction(action)) return Outcome(true, Via.ANCESTOR)
                break
            }
            parent = runCatching { parent!!.parent }.getOrNull()
            depth++
        }

        val point = visiblePoint(bounds, screen) ?: return Outcome(false, null)
        val ok = tap(point.first, point.second, long)
        return Outcome(ok, if (ok) Via.GESTURE else null)
    }

    fun tap(x: Int, y: Int, long: Boolean = false): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val duration = if (long) 600L else 60L
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, duration))
            .build()
        return dispatch(gesture, duration)
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long = 350): Boolean {
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()
        return dispatch(gesture, durationMs)
    }

    fun setText(node: AccessibilityNodeInfo, text: String): Boolean {
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        if (!node.isFocused) runCatching { node.performAction(AccessibilityNodeInfo.ACTION_FOCUS) }
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return true
        // 有些输入框要先点进去才吃 SET_TEXT
        runCatching { node.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
        runCatching { node.refresh() }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    /** 键盘上的「搜索 / 发送 / 完成」（API 30+）。 */
    fun imeEnter(node: AccessibilityNodeInfo): Boolean {
        if (Build.VERSION.SDK_INT < 30) return false
        val id = AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id
        runCatching { node.refresh() }
        if (node.actionList.none { it.id == id }) return false
        return node.performAction(id)
    }

    fun scroll(
        node: AccessibilityNodeInfo?,
        scrollBits: Int,
        horizontal: Boolean,
        direction: String,
        bounds: Box,
        screen: Box,
    ): Outcome {
        if (node != null) {
            scrollAction(scrollBits, horizontal, direction)?.let { action ->
                if (node.performAction(action)) return Outcome(true, Via.NODE)
            }
        }
        // 留出状态栏与底部手势条
        val area = bounds.intersect(
            Box(screen.left, screen.top + screen.height / 20, screen.right, screen.bottom - screen.height * 6 / 100),
        )
        if (area.isEmpty || area.height < 40 || area.width < 40) return Outcome(false, null)
        val cx = area.centerX
        val cy = area.centerY
        val dy = area.height * 3 / 10
        val dx = area.width * 3 / 10
        val ok = when (direction) {
            // down = 看下面的内容：手指往上滑
            "down" -> swipe(cx, cy + dy, cx, cy - dy)
            "up" -> swipe(cx, cy - dy, cx, cy + dy)
            "right" -> swipe(cx + dx, cy, cx - dx, cy)
            "left" -> swipe(cx - dx, cy, cx + dx, cy)
            else -> false
        }
        return Outcome(ok, if (ok) Via.GESTURE else null)
    }

    fun global(key: String): Boolean = runCatching {
        service.performGlobalAction(
            when (key) {
                "back" -> AccessibilityService.GLOBAL_ACTION_BACK
                "home" -> AccessibilityService.GLOBAL_ACTION_HOME
                "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS
                "notifications" -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
                else -> return false
            },
        )
    }.getOrDefault(false)

    private fun scrollAction(bits: Int, horizontal: Boolean, direction: String): Int? = when (direction) {
        "down" -> when {
            bits and ScrollBits.DOWN != 0 -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
            !horizontal && bits and ScrollBits.FORWARD != 0 -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            else -> null
        }
        "up" -> when {
            bits and ScrollBits.UP != 0 -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
            !horizontal && bits and ScrollBits.BACKWARD != 0 -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            else -> null
        }
        "right" -> when {
            bits and ScrollBits.RIGHT != 0 -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
            horizontal && bits and ScrollBits.FORWARD != 0 -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            else -> null
        }
        "left" -> when {
            bits and ScrollBits.LEFT != 0 -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
            horizontal && bits and ScrollBits.BACKWARD != 0 -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            else -> null
        }
        else -> null
    }

    private fun visiblePoint(bounds: Box, screen: Box): Pair<Int, Int>? {
        val clipped = bounds.intersect(screen)
        if (clipped.isEmpty) return null
        return clipped.centerX to clipped.centerY
    }

    private fun dispatch(gesture: GestureDescription, durationMs: Long): Boolean {
        val latch = CountDownLatch(1)
        var completed = false
        val sent = runCatching {
            service.dispatchGesture(
                gesture,
                object : AccessibilityService.GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) {
                        completed = true
                        latch.countDown()
                    }

                    override fun onCancelled(gestureDescription: GestureDescription?) {
                        latch.countDown()
                    }
                },
                gestureHandler,
            )
        }.getOrDefault(false)
        if (!sent) return false
        latch.await(durationMs + 2_000, TimeUnit.MILLISECONDS)
        return completed
    }
}
