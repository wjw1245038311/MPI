package com.mpi.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Material3 只借它的**组件行为**，配色一律用 MPI 令牌（docs/MOBILE-NATIVE-DESIGN.md §5.1）。
 * 超出 Material3 语义槽的令牌（textDim / accentSoft / userBubble …）走 [LocalMpiColors]。
 */

@Immutable
data class MpiColors(
    val bg: Color,
    val surfaceMuted: Color,
    val border: Color,
    val borderStrong: Color,
    val textDim: Color,
    val textFaint: Color,
    val accentSoft: Color,
    val control: Color,
    val userBubble: Color,
    val codeBg: Color,
    val send: Color,
    val sendFg: Color,
    val ok: Color,
    val err: Color,
)

private val LightMpiColors = MpiColors(
    bg = LightBg,
    surfaceMuted = LightSurfaceMuted,
    border = LightBorder,
    borderStrong = LightBorderStrong,
    textDim = LightTextDim,
    textFaint = LightTextFaint,
    accentSoft = LightAccentSoft,
    control = LightControl,
    userBubble = LightUserBubble,
    codeBg = LightCodeBg,
    send = LightSend,
    sendFg = LightSendFg,
    ok = LightOk,
    err = LightErr,
)

private val DarkMpiColors = MpiColors(
    bg = DarkBg,
    surfaceMuted = DarkSurfaceMuted,
    border = DarkBorder,
    borderStrong = DarkBorderStrong,
    textDim = DarkTextDim,
    textFaint = DarkTextFaint,
    accentSoft = DarkAccentSoft,
    control = DarkControl,
    userBubble = DarkUserBubble,
    codeBg = DarkCodeBg,
    send = DarkSend,
    sendFg = DarkSendFg,
    ok = DarkOk,
    err = DarkErr,
)

val LocalMpiColors = staticCompositionLocalOf { LightMpiColors }

/** 取扩展令牌：`MpiTheme.colors.textDim` */
object MpiTheme {
    val colors: MpiColors
        @Composable get() = LocalMpiColors.current
}

private val LightScheme = lightColorScheme(
    primary = LightAccent,
    onPrimary = Color.White,
    background = LightBg,
    onBackground = LightText,
    surface = LightSurface,
    onSurface = LightText,
    surfaceVariant = LightSurfaceMuted,
    onSurfaceVariant = LightTextDim,
    outline = LightBorder,
    outlineVariant = LightBorderStrong,
    error = LightErr,
)

private val DarkScheme = darkColorScheme(
    primary = DarkAccent,
    onPrimary = Color(0xFF102015),
    background = DarkBg,
    onBackground = DarkText,
    surface = DarkSurface,
    onSurface = DarkText,
    surfaceVariant = DarkSurfaceMuted,
    onSurfaceVariant = DarkTextDim,
    outline = DarkBorder,
    outlineVariant = DarkBorderStrong,
    error = DarkErr,
)

/** 正文 15sp 基准（见 §5.2）。「设置 → 字号」三档在 M3 用它做缩放。 */
private val MpiTypography = Typography().let { base ->
    base.copy(
        bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
        titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
        labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    )
}

@Composable
fun MpiTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalMpiColors provides if (darkTheme) DarkMpiColors else LightMpiColors) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkScheme else LightScheme,
            typography = MpiTypography,
            content = content,
        )
    }
}
