package com.mpi.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * 手写图标集（不引入图标库，见 §1.2 / MOBILE-REMAINING-TODO 的约定）。
 *
 * 规格与桌面端 `icons.tsx` 一致：24 viewBox、`stroke=currentColor`、`strokeWidth 1.7`、
 * 圆头圆角。颜色由 `Icon(tint = …)` 覆盖，所以这里画的描边色只是占位。
 */
private fun strokeIcon(name: String, block: PathBuilder.() -> Unit): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).path(
        stroke = SolidColor(Color.Black),
        strokeLineWidth = 1.7f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
        pathBuilder = block,
    ).build()

/** 抽屉（三条横线）。 */
val IconMenu: ImageVector by lazy {
    strokeIcon("Menu") {
        moveTo(4f, 7f); lineTo(20f, 7f)
        moveTo(4f, 12f); lineTo(20f, 12f)
        moveTo(4f, 17f); lineTo(14f, 17f)
    }
}

/** 右尖括号（列表项的可点示意）。 */
val IconChevronRight: ImageVector by lazy {
    strokeIcon("ChevronRight") {
        moveTo(9f, 6f); lineTo(15f, 12f); lineTo(9f, 18f)
    }
}

/** 返回。 */
val IconArrowLeft: ImageVector by lazy {
    strokeIcon("ArrowLeft") {
        moveTo(15f, 5f); lineTo(8f, 12f); lineTo(15f, 19f)
    }
}

/** 关闭。 */
val IconClose: ImageVector by lazy {
    strokeIcon("Close") {
        moveTo(6f, 6f); lineTo(18f, 18f)
        moveTo(18f, 6f); lineTo(6f, 18f)
    }
}

/** 加号（新建会话，M2 起接入）。 */
val IconPlus: ImageVector by lazy {
    strokeIcon("Plus") {
        moveTo(12f, 5f); lineTo(12f, 19f)
        moveTo(5f, 12f); lineTo(19f, 12f)
    }
}

/** 权限（锁）——配置 chip 用。 */
val IconLock: ImageVector by lazy {
    strokeIcon("Lock") {
        moveTo(5f, 10f); lineTo(19f, 10f); lineTo(19f, 19.5f); lineTo(5f, 19.5f); close()
        moveTo(8f, 10f); lineTo(8f, 7f)
        curveTo(8f, 4.2f, 16f, 4.2f, 16f, 7f)
        lineTo(16f, 10f)
    }
}

/** 任务模式（闪电）。 */
val IconSpark: ImageVector by lazy {
    strokeIcon("Spark") {
        moveTo(13f, 3f); lineTo(5f, 14f); lineTo(10f, 14f)
        lineTo(9f, 21f); lineTo(17f, 10f); lineTo(12f, 10f); close()
    }
}

/** 模型（方框 + M）。 */
val IconModel: ImageVector by lazy {
    strokeIcon("Model") {
        moveTo(7f, 4f); lineTo(17f, 4f); curveTo(19f, 4f, 20f, 5f, 20f, 7f)
        lineTo(20f, 17f); curveTo(20f, 19f, 19f, 20f, 17f, 20f)
        lineTo(7f, 20f); curveTo(5f, 20f, 4f, 19f, 4f, 17f)
        lineTo(4f, 7f); curveTo(4f, 5f, 5f, 4f, 7f, 4f); close()
        moveTo(9f, 15f); lineTo(9f, 9f); lineTo(12f, 12f); lineTo(15f, 9f); lineTo(15f, 15f)
    }
}

/** 上下文用量（仪表盘）。 */
val IconGauge: ImageVector by lazy {
    strokeIcon("Gauge") {
        moveTo(4f, 17f); quadTo(4f, 9f, 12f, 9f); quadTo(20f, 9f, 20f, 17f)
        moveTo(12f, 17f); lineTo(16f, 12f)
    }
}

/** 勾选（Sheet 里当前项）。 */
val IconCheck: ImageVector by lazy {
    strokeIcon("Check") {
        moveTo(5f, 13f); lineTo(9f, 17f); lineTo(19f, 7f)
    }
}

/** 复制（消息操作）。 */
val IconCopy: ImageVector by lazy {
    strokeIcon("Copy") {
        moveTo(9f, 9f); lineTo(18f, 9f); lineTo(18f, 18f); lineTo(9f, 18f); close()
        moveTo(5f, 15f); lineTo(5f, 5f); lineTo(15f, 5f); lineTo(15f, 6f)
    }
}

/** 回到底部。 */
val IconDown: ImageVector by lazy {
    strokeIcon("Down") {
        moveTo(12f, 5f); lineTo(12f, 19f)
        moveTo(6f, 13f); lineTo(12f, 19f); lineTo(18f, 13f)
    }
}

/** 发送（上箭头）。 */
val IconSend: ImageVector by lazy {
    strokeIcon("Send") {
        moveTo(12f, 19f); lineTo(12f, 5f)
        moveTo(5f, 12f); lineTo(12f, 5f); lineTo(19f, 12f)
    }
}

/** 停止（方块）。 */
val IconStop: ImageVector by lazy {
    strokeIcon("Stop") {
        moveTo(7f, 7f); lineTo(17f, 7f); lineTo(17f, 17f); lineTo(7f, 17f); close()
    }
}

/** 铅笔（取回「待处理后续」重新编辑）。 */
val IconEdit: ImageVector by lazy {
    strokeIcon("Edit") {
        moveTo(4f, 20f); lineTo(4f, 16f); lineTo(15f, 5f); lineTo(19f, 9f); lineTo(8f, 20f); close()
    }
}

/** 麦克风（语音输入）。 */
val IconMic: ImageVector by lazy {
    strokeIcon("Mic") {
        moveTo(9f, 11f); lineTo(9f, 6f)
        curveTo(9f, 3.3f, 15f, 3.3f, 15f, 6f)
        lineTo(15f, 11f); curveTo(15f, 13.7f, 9f, 13.7f, 9f, 11f); close()
        moveTo(5f, 11f); curveTo(5f, 19f, 19f, 19f, 19f, 11f)
        moveTo(12f, 17f); lineTo(12f, 21f)
    }
}

// ---- 设置页分组图标（沿用 24 viewBox / stroke 1.7 / 圆头）----

/** 新建对话（气泡 + 加号）：用在左侧面板底部那个悬浮气泡上。 */
val IconNewChat: ImageVector by lazy {
    strokeIcon("NewChat") {
        // 气泡本体（左下带小尾巴的圆角矩形）
        moveTo(9.5f, 5.5f); lineTo(4.5f, 5.5f)
        curveTo(3.4f, 5.5f, 3f, 6.1f, 3f, 7.1f)
        lineTo(3f, 15.1f); curveTo(3f, 16.1f, 3.4f, 16.7f, 4.5f, 16.7f)
        lineTo(6f, 16.7f); lineTo(6f, 20f); lineTo(9.8f, 16.7f)
        lineTo(14.5f, 16.7f); curveTo(15.6f, 16.7f, 16f, 16.1f, 16f, 15.1f)
        lineTo(16f, 13f)
        // 加号
        moveTo(17.5f, 4.2f); lineTo(17.5f, 10.2f)
        moveTo(14.5f, 7.2f); lineTo(20.5f, 7.2f)
    }
}

/**
 * 即时语音（声波）：语音对话模式开着时替掉话筒图标——一眼看出「现在是连续对话模式」，
 * 点它退出。
 */
val IconVoiceChat: ImageVector by lazy {
    strokeIcon("VoiceChat") {
        moveTo(4f, 10f); lineTo(4f, 14f)
        moveTo(8f, 7f); lineTo(8f, 17f)
        moveTo(12f, 4.5f); lineTo(12f, 19.5f)
        moveTo(16f, 7f); lineTo(16f, 17f)
        moveTo(20f, 10f); lineTo(20f, 14f)
    }
}

/** 通知。 */
val IconBell: ImageVector by lazy {
    strokeIcon("Bell") {
        moveTo(5f, 17f); lineTo(7f, 15f); lineTo(7f, 10f)
        curveTo(7f, 5.5f, 17f, 5.5f, 17f, 10f)
        lineTo(17f, 15f); lineTo(19f, 17f); close()
        moveTo(10f, 20f); curveTo(10f, 22f, 14f, 22f, 14f, 20f)
    }
}

/** 语言。 */
val IconGlobe: ImageVector by lazy {
    strokeIcon("Globe") {
        moveTo(12f, 3f); curveTo(17f, 3f, 21f, 7f, 21f, 12f)
        curveTo(21f, 17f, 17f, 21f, 12f, 21f)
        curveTo(7f, 21f, 3f, 17f, 3f, 12f)
        curveTo(3f, 7f, 7f, 3f, 12f, 3f); close()
        moveTo(3f, 12f); lineTo(21f, 12f)
        moveTo(12f, 3f); curveTo(15f, 7f, 15f, 17f, 12f, 21f)
        moveTo(12f, 3f); curveTo(9f, 7f, 9f, 17f, 12f, 21f)
    }
}

/** 外观（太阳）。 */
val IconSun: ImageVector by lazy {
    strokeIcon("Sun") {
        moveTo(12f, 8f); curveTo(14.2f, 8f, 16f, 9.8f, 16f, 12f)
        curveTo(16f, 14.2f, 14.2f, 16f, 12f, 16f)
        curveTo(9.8f, 16f, 8f, 14.2f, 8f, 12f)
        curveTo(8f, 9.8f, 9.8f, 8f, 12f, 8f); close()
        moveTo(12f, 2f); lineTo(12f, 4f)
        moveTo(12f, 20f); lineTo(12f, 22f)
        moveTo(2f, 12f); lineTo(4f, 12f)
        moveTo(20f, 12f); lineTo(22f, 12f)
        moveTo(4.9f, 4.9f); lineTo(6.3f, 6.3f)
        moveTo(17.7f, 17.7f); lineTo(19.1f, 19.1f)
        moveTo(4.9f, 19.1f); lineTo(6.3f, 17.7f)
        moveTo(17.7f, 6.3f); lineTo(19.1f, 4.9f)
    }
}

/** 清理缓存（垃圾桶）。 */
val IconTrash: ImageVector by lazy {
    strokeIcon("Trash") {
        moveTo(4f, 6f); lineTo(20f, 6f)
        moveTo(9f, 6f); lineTo(9f, 4f); lineTo(15f, 4f); lineTo(15f, 6f)
        moveTo(6f, 6f); lineTo(7f, 20f); lineTo(17f, 20f); lineTo(18f, 6f)
        moveTo(10f, 10f); lineTo(10f, 17f)
        moveTo(14f, 10f); lineTo(14f, 17f)
    }
}

/** 诊断（盾）。 */
val IconShield: ImageVector by lazy {
    strokeIcon("Shield") {
        moveTo(12f, 3f); lineTo(19f, 6f); lineTo(19f, 12f)
        curveTo(19f, 17f, 12f, 21f, 12f, 21f)
        curveTo(12f, 21f, 5f, 17f, 5f, 12f)
        lineTo(5f, 6f); close()
    }
}

/** 关于（信息）。 */
val IconInfo: ImageVector by lazy {
    strokeIcon("Info") {
        moveTo(12f, 3f); curveTo(17f, 3f, 21f, 7f, 21f, 12f)
        curveTo(21f, 17f, 17f, 21f, 12f, 21f)
        curveTo(7f, 21f, 3f, 17f, 3f, 12f)
        curveTo(3f, 7f, 7f, 3f, 12f, 3f); close()
        moveTo(12f, 11f); lineTo(12f, 16.5f)
        moveTo(12f, 7.5f); lineTo(12f, 8.2f)
    }
}

/** 检查更新（循环箭头）。 */
val IconRefresh: ImageVector by lazy {
    strokeIcon("Refresh") {
        moveTo(20f, 12f); curveTo(20f, 16.4f, 16.4f, 20f, 12f, 20f)
        curveTo(7.6f, 20f, 4f, 16.4f, 4f, 12f)
        curveTo(4f, 7.6f, 7.6f, 4f, 12f, 4f)
        lineTo(16f, 4f)
        moveTo(14f, 2f); lineTo(16f, 4f); lineTo(14f, 6f)
    }
}

/** 退出（门 + 出箭头）。 */
val IconLogout: ImageVector by lazy {
    strokeIcon("Logout") {
        moveTo(10f, 4f); lineTo(5f, 4f); lineTo(5f, 20f); lineTo(10f, 20f)
        moveTo(14f, 12f); lineTo(21f, 12f)
        moveTo(18f, 9f); lineTo(21f, 12f); lineTo(18f, 15f)
    }
}

/** 文件（附件/文件行）。 */
val IconFile: ImageVector by lazy {
    strokeIcon("File") {
        moveTo(14f, 3f); lineTo(7f, 3f)
        curveTo(5.9f, 3f, 5f, 3.9f, 5f, 5f)
        lineTo(5f, 19f); curveTo(5f, 20.1f, 5.9f, 21f, 7f, 21f)
        lineTo(17f, 21f); curveTo(18.1f, 21f, 19f, 20.1f, 19f, 19f)
        lineTo(19f, 8f); close()
        moveTo(14f, 3f); lineTo(14f, 8f); lineTo(19f, 8f)
    }
}

/** 更多（竖排三点，圆头描边显示为圆点）。 */
val IconMoreVertical: ImageVector by lazy {
    strokeIcon("MoreVertical") {
        moveTo(12f, 5.5f); lineTo(12f, 5.6f)
        moveTo(12f, 12f); lineTo(12f, 12.1f)
        moveTo(12f, 18.5f); lineTo(12f, 18.6f)
    }
}

/** 实心图标底座（fill + 可选 EvenOdd，用来挖内孔）。 */
private fun fillIcon(
    name: String,
    fillType: PathFillType = PathFillType.NonZero,
    block: PathBuilder.() -> Unit,
): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).path(
        fill = SolidColor(Color.Black),
        pathFillType = fillType,
        pathBuilder = block,
    ).build()

/** 四段贝塞尔近似圆（实心图标内部用）。 */
private fun PathBuilder.circlePath(cx: Float, cy: Float, r: Float) {
    val k = r * 0.5523f
    moveTo(cx, cy - r)
    curveTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy)
    curveTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r)
    curveTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy)
    curveTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r)
    close()
}

/** 设置（实心齿轮：8 个齿 + 中心孔）。 */
val IconSettings: ImageVector by lazy {
    fillIcon("Settings", PathFillType.EvenOdd) {
        val cx = 12f
        val cy = 12f
        val inner = 6.2f
        val outer = 8.9f
        var first = true
        for (i in 0 until 8) {
            for (offsetDeg in intArrayOf(-20, -11, 11, 20)) {
                val radius = if (offsetDeg == -20 || offsetDeg == 20) inner else outer
                val rad = Math.toRadians((i * 45 + offsetDeg).toDouble())
                val x = cx + (radius * Math.cos(rad)).toFloat()
                val y = cy + (radius * Math.sin(rad)).toFloat()
                if (first) {
                    moveTo(x, y)
                    first = false
                } else {
                    lineTo(x, y)
                }
            }
        }
        close()
        circlePath(cx, cy, 3.1f)
    }
}

/** 搜索（实心放大镜：镜片环 + 手柄）。 */
val IconSearch: ImageVector by lazy {
    fillIcon("Search", PathFillType.EvenOdd) {
        circlePath(11f, 11f, 5.6f)
        circlePath(11f, 11f, 3.9f)
        moveTo(15.3f, 13.9f)
        lineTo(20.6f, 19.2f)
        lineTo(19.2f, 20.6f)
        lineTo(13.9f, 15.3f)
        close()
    }
}



/** 向下尖括号（分组折叠/展开）。 */
val IconChevronDown: ImageVector by lazy {
    strokeIcon("ChevronDown") {
        moveTo(6f, 9f); lineTo(12f, 15f); lineTo(18f, 9f)
    }
}

/** 终端（工具 / bash 调用）：外框 + `>` 提示符 + 光标。 */
val IconTerminal: ImageVector by lazy {
    strokeIcon("Terminal") {
        moveTo(4f, 5f); lineTo(20f, 5f); lineTo(20f, 19f); lineTo(4f, 19f); close()
        moveTo(8f, 9.5f); lineTo(11f, 12f); lineTo(8f, 14.5f)
        moveTo(13.5f, 14.5f); lineTo(16.5f, 14.5f)
    }
}

/** 终端 + 斜杠：工具调用已隐藏。 */
val IconTerminalOff: ImageVector by lazy {
    strokeIcon("TerminalOff") {
        moveTo(4f, 5f); lineTo(20f, 5f); lineTo(20f, 19f); lineTo(4f, 19f); close()
        moveTo(8f, 9.5f); lineTo(11f, 12f); lineTo(8f, 14.5f)
        moveTo(5.5f, 18.5f); lineTo(18.5f, 5.5f)
    }
}
