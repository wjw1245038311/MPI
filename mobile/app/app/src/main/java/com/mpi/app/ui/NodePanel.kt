package com.mpi.app.ui

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.ui.theme.MpiTheme
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * 「会话节点」抽屉（对齐桌面端左侧的用户消息导航，也对齐 App 左边缘那个会话列表抽屉的手感）。
 *
 * 手感三件事（上一版是「划一下就整块弹出」，被反馈不流畅 + 会误触）：
 * 1. **只在右边缘起手**才认（[EDGE_WIDTH]）——这是不误触的关键；
 * 2. **跟手**：拖动距离直接驱动面板位移，松手按「位移 + 速度」吸附到开/关（spring 收尾）；
 * 3. 边缘常驻一个**箭头把手**，提示这里可以拉，点它也能打开。
 *
 * 为什么把手势挂在**消息区那个 Box** 上、而不是叠一条窄把手层：Box 与其子节点 LazyColumn
 * 同处一条命中链，这里只消费横向拖拽，纵向滚动照旧归列表；叠窄条会把那条缝里的滚动吃掉。
 */
@Stable
class NodePanelState(
    private val scope: CoroutineScope,
    private val panelWidthPx: Float,
    /** 吸附速度阈值（px/s）：与 ModalNavigationDrawer 的 DrawerVelocityThreshold（400.dp）一致。 */
    private val velocityThresholdPx: Float,
) {
    /** 0 = 收起；-panelWidthPx = 完全展开。 */
    var offset by mutableFloatStateOf(0f)
        private set

    private var settleJob: Job? = null

    /** 展开进度 0..1（面板位移 / 透明度都按它算）。 */
    val progress: Float get() = (-offset / panelWidthPx).coerceIn(0f, 1f)

    fun dragBy(delta: Float) {
        settleJob?.cancel()
        offset = (offset + delta).coerceIn(-panelWidthPx, 0f)
    }

    fun settle(velocity: Float) {
        val open = offset < -panelWidthPx * OPEN_FRACTION || velocity < -velocityThresholdPx
        animateTo(if (open) -panelWidthPx else 0f)
    }

    /**
     * 系统返回手势（预测性返回）驱动的跟手：直接把位移设成进度对应的位置。
     * 0 = 收起，1 = 完全展开（见 MainActivity 的右侧侧滑）。
     */
    fun dragToProgress(progress: Float) {
        settleJob?.cancel()
        offset = -panelWidthPx * progress.coerceIn(0f, 1f)
    }

    fun open() = animateTo(-panelWidthPx)

    fun close() = animateTo(0f)

    private fun animateTo(target: Float) {
        settleJob?.cancel()
        settleJob = scope.launch {
            animate(
                initialValue = offset,
                targetValue = target,
                // 与 ModalNavigationDrawer 的 AnchoredDraggableDefaultAnimationSpec 一致（Tween 256ms）
                animationSpec = tween(SETTLE_MS),
            ) { value, _ -> offset = value }
        }
    }

    companion object {
        /** 拖过面板宽度的这个比例就吸附到「开」——与 ModalNavigationDrawer 的 DrawerPositionalThreshold 一致。 */
        const val OPEN_FRACTION = 0.5f

        /** 吸附动画时长（ms）——与 ModalNavigationDrawer 的 AnchoredDraggableDefaultAnimationSpec 一致。 */
        const val SETTLE_MS = 256
    }
}

@Composable
internal fun rememberNodePanelState(panelWidth: Dp): NodePanelState {
    val density = LocalDensity.current
    val widthPx = with(density) { panelWidth.toPx() }
    // 速度阈值取 ModalNavigationDrawer 的 DrawerVelocityThreshold（400.dp），保证左右两侧吸附手感一致
    val velocityPx = with(density) { 400.dp.toPx() }
    val scope = rememberCoroutineScope()
    return remember(widthPx, velocityPx) { NodePanelState(scope, widthPx, velocityPx) }
}

/**
 * 跟手拉出右侧节点面板——**与左侧会话列表抽屉（ModalNavigationDrawer）逐项对齐**。
 *
 * 读 Material3 的 NavigationDrawer.kt 后照抄它的口径（不再猜）：
 *  - **不限制起手区**：左侧抽屉的 `Modifier.anchoredDraggable(...)` 挂在整个根 Box 上，
 *    任意位置的水平拖动都能拉出它（这也正是「左划也会弹出左侧列表」的原因）；
 *  - **吸附阈值**：`positionalThreshold = distance * 0.5f`、`velocityThreshold = 400.dp`；
 *  - **吸附动画**：`TweenSpec(durationMillis = 256)`——都落在 [NodePanelState] 里。
 *
 * 唯一的差别是**方向分工**（Material 的抽屉不区分方向，左右两个同时挂会互相抢）：
 *  - 面板收起时只认**向左**拖 → 拉出右侧面板；
 *  - 面板已打开时只认**向右**拖 → 把它收回去；
 *  - 另一个方向整个让给左侧会话列表抽屉。
 *
 * 纵向一律不消费（还给 LazyColumn 滚动）：判定口径是「横向 0.6×touchSlop 且允许明显斜向」
 * 对「纵向 2×touchSlop」——手指从边缘往里划时天然带纵向分量，判太严会直接放弃整个手势。
 *
 * **挂载位置**：必须挂在 `ModalNavigationDrawer` 外面（见 DrawerHost）配 Initial 阶段，
 * 才能先于抽屉消费掉属于我们的那次拖动。
 */
internal fun Modifier.edgeSwipeNodePanel(
    enabled: Boolean,
    state: NodePanelState,
): Modifier {
    if (!enabled) return this
    return pointerInput(enabled) {
        val touchSlop = viewConfiguration.touchSlop
        val horizontalTrigger = touchSlop * 0.6f
        val verticalGiveUp = touchSlop * 2f
        awaitEachGesture {
            // ⚠️ 必须用 **Initial 阶段**：本手势挂在 ModalNavigationDrawer 的 modifier 上
            // （抽屉的祖先），Initial 是「根 → 叶」——我们最先拿到事件，横向拖动一消费，
            // 抽屉在后面的 Main 阶段就看不到了。换成 Main 必输（那是叶 → 根，抽屉先跑）。
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            // 起手区：**不限制**（与左侧抽屉对称——它也是全屏任意位置）。屏幕最右那一条
            // 归系统返回手势，由 MpiApp 的 systemGestureExclusion 申请回来。
            // closing：面板已经（部分）打开时，方向反过来——向右拖是把它收回去。
            val closing = state.progress > 0.01f
            val tracker = VelocityTracker().apply { addPosition(down.uptimeMillis, down.position) }
            var total = 0f
            var dragging = false
            while (true) {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                if (!change.pressed) break
                // 已被更外层节点处理：不插手
                if (!dragging && change.isConsumed) break
                tracker.addPosition(change.uptimeMillis, change.position)
                val dx = change.position.x - down.position.x
                val dy = change.position.y - down.position.y
                if (!dragging) {
                    if (abs(dx) > horizontalTrigger && abs(dx) > abs(dy) * 0.6f) {
                        val mine = if (closing) dx > 0f else dx < 0f
                        if (mine) dragging = true else break
                    } else if (abs(dy) > verticalGiveUp) {
                        // 纵向明显主导 = 用户在滚列表：**此前一个事件都没消费过**，直接放行
                        break
                    } else {
                        continue
                    }
                }
                state.dragBy(dx - total)
                total = dx
                change.consume()
            }
            if (dragging) state.settle(tracker.calculateVelocity().x)
        }
    }
}

/**
 * 节点抽屉本体：半透明遮罩 + 面板（没有常驻把手——用户要的是系统边缘手势那种动态指示器，
 * 拖动时面板自己跟手出现就是指示）。
 *
 * 遮罩只在展开时参与命中（收起时整块都不挂载），否则会把消息区的点击吞掉。
 */
@Composable
internal fun NodePanelLayer(
    nodes: List<UserNode>,
    /** 视口首个可见项下标（传 lambda：**只在面板可见时读**，否则整个会话页会随滚动重组）。 */
    activeIndex: () -> Int,
    state: NodePanelState,
    panelWidth: Dp,
    onJump: (UserNode) -> Unit,
) {
    val progress = state.progress
    val scope = rememberCoroutineScope()
    // 密度在 composable 上下文里读一次；offset 的 lambda 不是 @Composable，不能在里面读 LocalDensity
    val panelWidthPx = with(LocalDensity.current) { panelWidth.toPx() }

    Box(Modifier.fillMaxSize()) {
        if (progress > 0.01f) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.32f * progress))
                    .clickable(enabled = progress > 0.5f) { scope.launch { state.close() } },
            )
        }

        // 收起时整块 Column 都不挂载（不只是内部内容）：面板视觉上被 offset 推出了屏幕，
        // 但它上面挂的 pointerInput 命中区域是按**修饰符外层**算的——留在屏幕右侧就是一块
        // 看不见的「占位区」，会把消息区右侧的纵向滚动与点击一起吃掉
        // （真机反馈：「右边没法下拉」「右侧点不中输入」）。
        // 拖动第一帧 progress 就 > 0，所以出现时机没有可感知的延迟。
        if (progress > 0.01f) {
            Column(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    // ⚠️ offset 必须在 edgeSwipeNodePanel **之前**：offset 只平移它内层的内容，
                    // 挂在它外层的话 pointerInput 的命中区域不会跟着移出屏幕。
                    .offset { IntOffset((panelWidthPx + state.offset).roundToInt(), 0) }
                    .width(panelWidth)
                    .fillMaxHeight()
                    .background(MpiTheme.colors.surfaceMuted),
            ) {
                val activeId = nodes.lastOrNull { it.index <= activeIndex() }?.id
                Text(
                    text = "会话节点（${nodes.size}）",
                    style = MaterialTheme.typography.labelMedium,
                    color = MpiTheme.colors.textDim,
                    modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 14.dp, bottom = 6.dp),
                )
                if (nodes.isEmpty()) {
                    Text(
                        text = "还没有你的发言",
                        style = MaterialTheme.typography.bodySmall,
                        color = MpiTheme.colors.textFaint,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                    )
                } else {
                    LazyColumn(Modifier.fillMaxSize()) {
                        itemsIndexed(nodes, key = { _, node -> node.id }) { ordinal, node ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(if (node.id == activeId) MpiTheme.colors.accentSoft else Color.Transparent)
                                    .clickable { onJump(node) }
                                    .padding(horizontal = 14.dp, vertical = 10.dp),
                            ) {
                                Text(
                                    text = "${ordinal + 1}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MpiTheme.colors.textFaint,
                                    modifier = Modifier.width(22.dp),
                                )
                                Text(
                                    text = node.preview,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 会话节点：一条用户消息（跳转锚点）。[index] = 在传入列表里的下标，用于滚动定位。 */
internal data class UserNode(val id: String, val index: Int, val preview: String)

/**
 * 提取「会话节点」列表（纯函数，可单测）：每条**用户消息**一个节点——与桌面端左侧
 * 用户消息导航（参考 Qwen 网页版）同口径；手机上一条用户消息就是一个回合，不再分组。
 * 跳过乐观回显（pending）：它还没落到主机，跳过去没有意义。
 */
internal fun userMessageNodes(messages: List<ThreadMessage>): List<UserNode> =
    messages.mapIndexedNotNull { index, message ->
        if (message.role != "user" || message.pending) return@mapIndexedNotNull null
        val text = messageTextOf(message).replace(Regex("\\s+"), " ").trim()
        UserNode(id = message.id, index = index, preview = text.ifEmpty { "（图片/附件）" }.take(60))
    }

/**
 * 右边缘起手区宽度。
 *
 * ⚠️ 别调小到「真正的边缘」（曾用 16dp/24dp，真机根本划不出来）：Android 手势导航把屏幕最外
 * ~20-24dp 划给了系统返回手势，App 在那条缝里**收不到** event；而人手能稳定落下的位置也在
 * 边缘往里 1cm 左右。64dp 既盖住系统返回区、也留出手指的容错，同时不至于把「代码块横向
 * 滚动」这类正常操作抢走。
 */
internal val NODE_PANEL_EDGE = 64.dp

/** 面板宽度。 */
internal val NODE_PANEL_WIDTH = 268.dp
