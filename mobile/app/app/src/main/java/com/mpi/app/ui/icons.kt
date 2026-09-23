package com.mpi.app.ui

import androidx.compose.ui.graphics.Color
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
