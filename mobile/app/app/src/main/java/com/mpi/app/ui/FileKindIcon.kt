/**
 * 按文件类型画的彩色图标（安卓）。
 *
 * 与桌面 `FileTypeIcon` 的 windows 变体、PWA `FileKindIcon` 同一观感：白色页身 +
 * 折角 + 左下角彩色徽标（徽标里是字或小图形）。用户 2026-11-04 选的「彩色填充」，
 * 不用线条描边——手机上 20dp 的描边会糊。
 *
 * 为什么用 Canvas 画而不是内置 material-icons：
 *   1. 那套没有「压缩包 / 表格 / 幻灯片」这类办公文件图标，只能退化成通用文件；
 *   2. 引入 material-icons-extended 会把 apk 体积撑大几 MB，而这里只需要 10 个形状；
 *   3. 三个端用同一套路径数据，视觉上才像同一个产品。
 *
 * 分类全部来自 [FileKinds]（与 TS 源逐条对齐，见 scripts/test-file-kind.mjs）。
 */
package com.mpi.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mpi.app.data.FileCategory
import com.mpi.app.data.FileKinds

/** 每类的徽标底色（与桌面 WIN_BADGES / PWA BADGE_COLORS 对齐）。 */
private val BADGE_COLORS: Map<FileCategory, Color> = mapOf(
    FileCategory.Archive to Color(0xFF8E8E93),
    FileCategory.Pdf to Color(0xFFE5484D),
    FileCategory.Doc to Color(0xFF2B7CD3),
    FileCategory.Sheet to Color(0xFF21A366),
    FileCategory.Slide to Color(0xFFE8590C),
    FileCategory.Code to Color(0xFF4C6EF5),
    FileCategory.Image to Color(0xFF4C9AFF),
    FileCategory.Audio to Color(0xFFAF52DE),
    FileCategory.Video to Color(0xFFFF9F0A),
)

/** 徽标里的字（有字画字，没字画小图形）。 */
private val BADGE_LABELS: Map<FileCategory, String> = mapOf(
    FileCategory.Pdf to "PDF",
    FileCategory.Doc to "W",
    FileCategory.Sheet to "X",
    FileCategory.Slide to "P",
)

private val PAGE_FILL = Color.White
private val PAGE_EDGE = Color(0x38000000)
private val FOLD_FILL = Color(0xFFE9EBEF)
private val RULE_COLOR = Color(0xFFC3C7CE)

/**
 * 文件类型图标。
 *
 * @param name 可读文件名（决定分类）
 * @param mimeType 可选 mime（老快照没有时只靠后缀）
 * @param sideDp 边长（默认 22dp，与文件卡片的 28dp 容器搭配）
 */
@Composable
fun FileKindIcon(
    name: String?,
    mimeType: String? = null,
    sideDp: Int = 22,
    modifier: Modifier = Modifier,
) {
    val category = FileKinds.fileCategory(name, mimeType)
    val measurer = rememberTextMeasurer()
    val label = BADGE_LABELS[category]
    val badgeColor = BADGE_COLORS[category]

    Layout(
        content = {
            Canvas(Modifier.fillMaxSize()) {
                drawFileGlyph(category, badgeColor)
            }
            // 徽标文字用真文本画（PDF 三个字母在 9px 里手绘会糊）。
            if (label != null) {
                Canvas(Modifier.fillMaxSize()) {
                    val text = label
                    val layout = measurer.measure(
                        text = text,
                        style = TextStyle(
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize = if (text.length > 1) 4.6.sp else 7.2.sp,
                        ),
                    )
                    // 徽标方块在 viewBox 里的位置（3,12)-(12.5,21.5)，中点是 (7.75, 16.75)
                    val cx = size.width * (7.75f / 24f)
                    val cy = size.height * (16.85f / 24f)
                    drawText(
                        textLayoutResult = layout,
                        topLeft = Offset(cx - layout.size.width / 2f, cy - layout.size.height / 2f),
                    )
                }
            }
        },
        modifier = modifier,
    ) { measurables, constraints ->
        val side = sideDp.dp.roundToPx().coerceAtLeast(1)
        val bounded = Constraints.fixed(side, side)
        val placeables = measurables.map { it.measure(bounded) }
        layout(side, side) {
            placeables.forEach { it.place(0, 0) }
        }
    }
}

/**
 * 在 24×24 的虚拟画布上画页身 + 折角 + 徽标（与 SVG 里同一套坐标）。
 *
 * 为什么不用 Path 做圆角矩形：`drawRoundRect` 已经够用，且比手搓贝塞尔稳。
 */
private fun DrawScope.drawFileGlyph(category: FileCategory, badgeColor: Color?) {
    val u = size.width / 24f
    fun p(x: Float, y: Float) = Offset(x * u, y * u)
    val pageW = 14.5f * u
    val pageH = 18f * u

    // 页身：白色圆角矩形（(4.5,3) 起）
    drawRoundRect(
        color = PAGE_FILL,
        topLeft = p(4.5f, 3f),
        size = Size(pageW, pageH),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(2f * u, 2f * u),
    )
    drawRoundRect(
        color = PAGE_EDGE,
        topLeft = p(4.5f, 3f),
        size = Size(pageW, pageH),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(2f * u, 2f * u),
        style = Stroke(width = 1f * u),
    )

    // 折角：右上角三角（(13.5,3) → (19,8.5)）
    val fold = Path().apply {
        moveTo(13.5f * u, 3f * u)
        lineTo(19f * u, 8.5f * u)
        lineTo(15f * u, 8.5f * u)
        close()
    }
    drawPath(fold, FOLD_FILL)

    if (badgeColor == null) {
        // 纯文本 / 其它：页身上两行横线（跟着固定灰，不抢眼）
        drawLine(RULE_COLOR, p(8.5f, 11f), p(15.5f, 11f), strokeWidth = 1.1f * u)
        drawLine(RULE_COLOR, p(8.5f, 14f), p(13.5f, 14f), strokeWidth = 1.1f * u)
        return
    }

    // 徽标方块：左下角 (3,12) 起、9.5 边长、圆角 2
    drawRoundRect(
        color = badgeColor,
        topLeft = p(3f, 12f),
        size = Size(9.5f * u, 9.5f * u),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(2f * u, 2f * u),
    )
    drawRoundRect(
        color = Color.White,
        topLeft = p(3f, 12f),
        size = Size(9.5f * u, 9.5f * u),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(2f * u, 2f * u),
        style = Stroke(width = 0.8f * u),
    )

    // 没有文字的类 → 画小图形（与桌面 glyph / PWA badgeGlyph 同构）
    if (BADGE_LABELS.containsKey(category)) return
    val stroke = Stroke(width = 1.2f * u, cap = androidx.compose.ui.graphics.StrokeCap.Round,
        join = androidx.compose.ui.graphics.StrokeJoin.Round)
    when (category) {
        FileCategory.Archive -> {
            drawRect(Color.White, topLeft = p(5.5f, 14.6f), size = Size(5f * u, 4.4f * u), style = stroke)
            drawLine(Color.White, p(5.5f, 16.7f), p(10.5f, 16.7f), strokeWidth = 1.2f * u)
        }
        FileCategory.Code -> {
            val path = Path().apply {
                moveTo(7.4f * u, 15.2f * u); lineTo(5.6f * u, 17.1f * u); lineTo(7.4f * u, 19f * u)
                moveTo(10.6f * u, 15.2f * u); lineTo(12.4f * u, 17.1f * u); lineTo(10.6f * u, 19f * u)
            }
            drawPath(path, Color.White, style = stroke)
        }
        FileCategory.Image -> {
            val path = Path().apply {
                moveTo(5f * u, 18.6f * u); lineTo(6.9f * u, 16.6f * u); lineTo(8.3f * u, 18f * u)
                lineTo(9.9f * u, 16.4f * u); lineTo(11.7f * u, 18.3f * u)
            }
            drawPath(path, Color.White, style = stroke)
        }
        FileCategory.Audio -> {
            drawLine(Color.White, p(8.6f, 14.5f), p(8.6f, 19.1f), strokeWidth = 1.2f * u)
            drawLine(Color.White, p(8.6f, 14.5f), p(11.2f, 13.9f), strokeWidth = 1.2f * u)
        }
        FileCategory.Video -> {
            val path = Path().apply {
                moveTo(6.4f * u, 15f * u); lineTo(9f * u, 16.5f * u); lineTo(11.6f * u, 15f * u)
                lineTo(11.6f * u, 18.2f * u); lineTo(9f * u, 19.7f * u); lineTo(6.4f * u, 18.2f * u)
                close()
            }
            drawPath(path, Color.White, style = stroke)
        }
        else -> Unit
    }
}
