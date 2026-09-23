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
