/**
 * 文件后缀 → 展示大类（`src/shared/file-kind.ts` 的 Kotlin 移植）。
 *
 * 安卓是独立构建的 Kotlin 工程，无法 import 那份 TS——与 `ImageNotes.kt`
 * （image-notes 的移植）同一约定。**两份必须给出相同分类**：
 * `scripts/test-file-kind.mjs` 会解析本文件的映射表，与 TS 源逐条比对，
 * 改一处忘另一处会直接失败。
 *
 * 判定顺序：**先按后缀，再按 mime**（与 TS 版一致）——用户看到的卡片标题是文件名，
 * 图标跟着名字走才不会出现「.xlsx 顶着图片图标」。
 */
package com.mpi.app.data

/** 展示大类。前 10 个有专属图标/配色，[Other] 是兜底（普通文件页）。 */
enum class FileCategory {
    Archive,
    Pdf,
    Doc,
    Sheet,
    Slide,
    Code,
    Text,
    Image,
    Audio,
    Video,
    Other,
}

object FileKinds {
    /** 后缀（小写、不含点）→ 大类。没列到的后缀一律 [FileCategory.Other]。 */
    val EXT_CATEGORY: Map<String, FileCategory> = mapOf(
        // 压缩包 / 安装包
        "zip" to FileCategory.Archive, "rar" to FileCategory.Archive, "7z" to FileCategory.Archive,
        "tar" to FileCategory.Archive, "gz" to FileCategory.Archive, "tgz" to FileCategory.Archive,
        "bz2" to FileCategory.Archive, "xz" to FileCategory.Archive, "zst" to FileCategory.Archive,
        "iso" to FileCategory.Archive, "apk" to FileCategory.Archive, "jar" to FileCategory.Archive,
        "msi" to FileCategory.Archive, "exe" to FileCategory.Archive, "dmg" to FileCategory.Archive,
        "pkg" to FileCategory.Archive, "deb" to FileCategory.Archive, "rpm" to FileCategory.Archive,

        "pdf" to FileCategory.Pdf,

        // Word 系
        "doc" to FileCategory.Doc, "docx" to FileCategory.Doc, "odt" to FileCategory.Doc,
        "rtf" to FileCategory.Doc, "wps" to FileCategory.Doc, "pages" to FileCategory.Doc,

        // 表格
        "xls" to FileCategory.Sheet, "xlsx" to FileCategory.Sheet, "csv" to FileCategory.Sheet,
        "tsv" to FileCategory.Sheet, "ods" to FileCategory.Sheet, "et" to FileCategory.Sheet,
        "numbers" to FileCategory.Sheet,

        // 幻灯片
        "ppt" to FileCategory.Slide, "pptx" to FileCategory.Slide, "odp" to FileCategory.Slide,
        "dps" to FileCategory.Slide, "key" to FileCategory.Slide,

        // 代码 / 配置
        "ts" to FileCategory.Code, "mts" to FileCategory.Code, "cts" to FileCategory.Code,
        "tsx" to FileCategory.Code, "js" to FileCategory.Code, "mjs" to FileCategory.Code,
        "cjs" to FileCategory.Code, "jsx" to FileCategory.Code, "py" to FileCategory.Code,
        "go" to FileCategory.Code, "rs" to FileCategory.Code, "java" to FileCategory.Code,
        "kt" to FileCategory.Code, "swift" to FileCategory.Code, "c" to FileCategory.Code,
        "h" to FileCategory.Code, "cpp" to FileCategory.Code, "hpp" to FileCategory.Code,
        "cc" to FileCategory.Code, "cs" to FileCategory.Code, "rb" to FileCategory.Code,
        "php" to FileCategory.Code, "lua" to FileCategory.Code, "pl" to FileCategory.Code,
        "r" to FileCategory.Code, "m" to FileCategory.Code, "sh" to FileCategory.Code,
        "bash" to FileCategory.Code, "zsh" to FileCategory.Code, "ps1" to FileCategory.Code,
        "bat" to FileCategory.Code, "cmd" to FileCategory.Code, "sql" to FileCategory.Code,
        "vue" to FileCategory.Code, "svelte" to FileCategory.Code, "json" to FileCategory.Code,
        "jsonc" to FileCategory.Code, "yaml" to FileCategory.Code, "yml" to FileCategory.Code,
        "toml" to FileCategory.Code, "ini" to FileCategory.Code, "cfg" to FileCategory.Code,
        "conf" to FileCategory.Code, "env" to FileCategory.Code, "xml" to FileCategory.Code,
        "lock" to FileCategory.Code, "html" to FileCategory.Code, "htm" to FileCategory.Code,
        "css" to FileCategory.Code, "scss" to FileCategory.Code, "less" to FileCategory.Code,

        // 纯文本 / 日志
        "md" to FileCategory.Text, "markdown" to FileCategory.Text, "txt" to FileCategory.Text,
        "log" to FileCategory.Text, "rst" to FileCategory.Text, "tex" to FileCategory.Text,
        "srt" to FileCategory.Text, "vtt" to FileCategory.Text,

        // 图片
        "png" to FileCategory.Image, "jpg" to FileCategory.Image, "jpeg" to FileCategory.Image,
        "gif" to FileCategory.Image, "webp" to FileCategory.Image, "bmp" to FileCategory.Image,
        "ico" to FileCategory.Image, "avif" to FileCategory.Image, "heic" to FileCategory.Image,
        "heif" to FileCategory.Image, "tif" to FileCategory.Image, "tiff" to FileCategory.Image,
        "svg" to FileCategory.Image, "psd" to FileCategory.Image,

        // 音频
        "mp3" to FileCategory.Audio, "wav" to FileCategory.Audio, "m4a" to FileCategory.Audio,
        "aac" to FileCategory.Audio, "flac" to FileCategory.Audio, "ogg" to FileCategory.Audio,
        "opus" to FileCategory.Audio, "wma" to FileCategory.Audio, "aiff" to FileCategory.Audio,
        "amr" to FileCategory.Audio,

        // 视频
        "mp4" to FileCategory.Video, "m4v" to FileCategory.Video, "mov" to FileCategory.Video,
        "webm" to FileCategory.Video, "mkv" to FileCategory.Video, "avi" to FileCategory.Video,
        "wmv" to FileCategory.Video, "flv" to FileCategory.Video, "m3u8" to FileCategory.Video,
    )

    /** 取后缀（小写、不含点；无后缀 → 空串）。 */
    fun extOf(name: String?): String {
        val value = name.orEmpty()
        val base = value.substringAfterLast('/').substringAfterLast('\\')
        val dot = base.lastIndexOf('.')
        if (dot < 0) return ""
        return base.substring(dot + 1).lowercase()
    }

    /** mime → 大类（只在 mime 明确时给；`application/octet-stream` 不猜）。 */
    fun categoryForMime(mimeType: String?): FileCategory? {
        val mime = mimeType.orEmpty().lowercase().trim()
        if (mime.isEmpty() || mime == "application/octet-stream") return null
        return when {
            mime.startsWith("image/") -> FileCategory.Image
            mime.startsWith("audio/") -> FileCategory.Audio
            mime.startsWith("video/") -> FileCategory.Video
            mime == "application/pdf" -> FileCategory.Pdf
            mime.startsWith("text/") -> FileCategory.Text
            mime == "application/zip" || mime == "application/x-tar" || mime == "application/gzip" ||
                mime == "application/x-7z-compressed" || mime == "application/vnd.rar" -> FileCategory.Archive
            mime.contains("wordprocessingml") || mime == "application/msword" -> FileCategory.Doc
            mime.contains("spreadsheetml") || mime == "application/vnd.ms-excel" -> FileCategory.Sheet
            mime.contains("presentationml") || mime == "application/vnd.ms-powerpoint" -> FileCategory.Slide
            else -> null
        }
    }

    /** 主入口：名字 + 可选 mime → 大类（后缀优先，与 TS 版一致）。 */
    fun fileCategory(name: String?, mimeType: String? = null): FileCategory {
        val ext = extOf(name)
        EXT_CATEGORY[ext]?.let { return it }
        return categoryForMime(mimeType) ?: FileCategory.Other
    }
}
