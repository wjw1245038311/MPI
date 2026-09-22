package com.mpi.app.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * 设计令牌 —— 与桌面端（`src/renderer/src/styles.css`）及现有 PWA
 * （`mobile/pwa/src/styles.css`）**同名同值**。
 *
 * 新增颜色请沿用这里的命名（不带 Light/Dark 前缀的语义名），
 * 不要在别处另起别名或硬编码色值。见 docs/MOBILE-NATIVE-DESIGN.md §5.1。
 */

// ---- 浅色 ----
val LightBg = Color(0xFFFFFFFF)
val LightSurface = Color(0xFFFFFFFF)
val LightSurfaceMuted = Color(0xFFFAF9F4)
val LightBorder = Color(0xFFE7E7E1)
val LightBorderStrong = Color(0xFFD8D8D0)
val LightText = Color(0xFF1D1E1B)
val LightTextDim = Color(0xFF6C7066)
val LightTextFaint = Color(0xFF9AA096)
val LightAccent = Color(0xFF2E7D52)
val LightAccentSoft = Color(0xFFE4F1E8)
val LightSend = Color(0xFF2B2D28)
val LightSendFg = Color(0xFFFFFFFF)
val LightControl = Color(0xFFF3F3EE)
val LightUserBubble = Color(0xFFFFFFFF)
val LightCodeBg = Color(0xFFF5F5F1)
val LightOk = Color(0xFF2E7D52)
val LightErr = Color(0xFFC2402F)

// ---- 深色（背景用深灰而非纯黑：避免 OLED 烧屏与拖影）----
val DarkBg = Color(0xFF111619)
val DarkSurface = Color(0xFF1B2327)
val DarkSurfaceMuted = Color(0xFF202A2F)
val DarkBorder = Color(0xFF303C43)
val DarkBorderStrong = Color(0xFF53636C)
val DarkText = Color(0xFFE8EEF0)
val DarkTextDim = Color(0xFFB6C2C8)
val DarkTextFaint = Color(0xFF8B98A0)
val DarkAccent = Color(0xFF7BD6A1)
val DarkAccentSoft = Color(0xFF214333)
val DarkSend = Color(0xFF75C995)
val DarkSendFg = Color(0xFF102015)
val DarkControl = Color(0xFF273239)
val DarkUserBubble = Color(0xFF263830)
val DarkCodeBg = Color(0xFF151C20)
val DarkOk = Color(0xFF7BD6A1)
val DarkErr = Color(0xFFF7768E)
