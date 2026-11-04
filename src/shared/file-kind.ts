/**
 * 文件后缀 → 展示大类（三端共用口径）。
 *
 * 用途：聊天里的文件卡片按类型给不同的彩色图标（压缩包 / PDF / 文档 / 表格 / 幻灯片 /
 * 代码 / 纯文本 / 图片 / 音视频 / 其它），而不是一律一个回形针或 📄。
 *
 * 为什么是「一份 TS + 一份 Kotlin 副本」：桌面渲染层与 PWA 都是 TS，直接 import 本文件；
 * 安卓是独立构建的 Kotlin 工程，无法 import（与 `image-notes.ts` / choice-block 的三端
 * 复制同一约定）。**两份必须给出相同分类**——`scripts/test-file-kind.mjs` 里有一条哨兵
 * 按同一批后缀比对（安卓那份在 `data/FileKinds.kt`），改一处忘了另一处会直接失败。
 *
 * 判定顺序：**先按 mime，再按后缀**。mime 缺省时才看后缀——手机端有的块只有 label、
 * 没有 mimeType（见 RemoteMessage.blocks 的注释），此时后缀是唯一线索。
 */

/** 展示大类。前 10 个有专属图标/配色，`other` 是兜底（普通文件页）。 */
export type FileCategory =
  | "archive"
  | "pdf"
  | "doc"
  | "sheet"
  | "slide"
  | "code"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "other";

/** 后缀（含点，小写）→ 大类。没列到的后缀一律 `other`。 */
export const EXT_CATEGORY: Record<string, FileCategory> = {
  // 压缩包 / 镜像安装包：最常见的「我得先存下来」的一类。
  ".zip": "archive", ".rar": "archive", ".7z": "archive", ".tar": "archive", ".gz": "archive",
  ".tgz": "archive", ".bz2": "archive", ".xz": "archive", ".zst": "archive", ".iso": "archive",
  ".apk": "archive", ".jar": "archive", ".msi": "archive", ".exe": "archive", ".dmg": "archive",
  ".pkg": "archive", ".deb": "archive", ".rpm": "archive",

  ".pdf": "pdf",

  // Word 系（含 WPS 的 .wps/.et/.dps 与 Apple 的 .pages）。
  ".doc": "doc", ".docx": "doc", ".odt": "doc", ".rtf": "doc", ".wps": "doc", ".pages": "doc",

  // 表格
  ".xls": "sheet", ".xlsx": "sheet", ".csv": "sheet", ".tsv": "sheet", ".ods": "sheet", ".et": "sheet",
  ".numbers": "sheet",

  // 幻灯片
  ".ppt": "slide", ".pptx": "slide", ".odp": "slide", ".dps": "slide", ".key": "slide",

  // 代码 / 配置：桌面端已有 code 分类，这里沿用同一批后缀。
  ".ts": "code", ".mts": "code", ".cts": "code", ".tsx": "code",
  ".js": "code", ".mjs": "code", ".cjs": "code", ".jsx": "code",
  ".py": "code", ".go": "code", ".rs": "code", ".java": "code", ".kt": "code", ".swift": "code",
  ".c": "code", ".h": "code", ".cpp": "code", ".hpp": "code", ".cc": "code", ".cs": "code",
  ".rb": "code", ".php": "code", ".lua": "code", ".pl": "code", ".r": "code", ".m": "code",
  ".sh": "code", ".bash": "code", ".zsh": "code", ".ps1": "code", ".bat": "code", ".cmd": "code",
  ".sql": "code", ".vue": "code", ".svelte": "code",
  ".json": "code", ".jsonc": "code", ".yaml": "code", ".yml": "code", ".toml": "code",
  ".ini": "code", ".cfg": "code", ".conf": "code", ".env": "code", ".xml": "code", ".lock": "code",
  ".html": "code", ".htm": "code", ".css": "code", ".scss": "code", ".less": "code",

  // 纯文本 / 日志 / 文档源
  ".md": "text", ".markdown": "text", ".txt": "text", ".log": "text", ".rst": "text",
  ".tex": "text", ".srt": "text", ".vtt": "text",

  // 图片
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image",
  ".bmp": "image", ".ico": "image", ".avif": "image", ".heic": "image", ".heif": "image",
  ".tif": "image", ".tiff": "image", ".svg": "image", ".psd": "image",

  // 音频
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".aac": "audio", ".flac": "audio",
  ".ogg": "audio", ".opus": "audio", ".wma": "audio", ".aiff": "audio", ".amr": "audio",

  // 视频
  ".mp4": "video", ".m4v": "video", ".mov": "video", ".webm": "video", ".mkv": "video",
  ".avi": "video", ".wmv": "video", ".flv": "video", ".m3u8": "video",
};

/**
 * MIME → 大类。只在 mime 明确时给出（`application/octet-stream` 这类不猜，交给后缀）。
 */
export function categoryForMime(mimeType: string | undefined | null): FileCategory | null {
  const mime = String(mimeType || "").toLowerCase().trim();
  if (!mime || mime === "application/octet-stream") return null;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/zip" || mime === "application/x-tar" || mime === "application/gzip" ||
      mime === "application/x-7z-compressed" || mime === "application/vnd.rar") return "archive";
  if (mime.includes("wordprocessingml") || mime === "application/msword") return "doc";
  if (mime.includes("spreadsheetml") || mime === "application/vnd.ms-excel") return "sheet";
  if (mime.includes("presentationml") || mime === "application/vnd.ms-powerpoint") return "slide";
  return null;
}

/** 取后缀（含点、小写；无后缀给空串）。 */
export function extOf(name: string | undefined | null): string {
  const value = String(name || "");
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const base = slash >= 0 ? value.slice(slash + 1) : value;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  // dot === 0 = 整个名字就是后缀（`.env` / `.gitignore`），照样算分类依据。
  return base.slice(dot).toLowerCase();
}

/**
 * 主入口：名字 + 可选 mime → 大类。
 *
 * 只给文件名（手机端某些块没有 mime）时靠后缀；两者冲突时**后缀优先**——
 * 用户看到的卡片标题是文件名，图标跟着名字走才不会出现「.xlsx 顶着图片图标」。
 */
export function fileCategory(name?: string | null, mimeType?: string | null): FileCategory {
  const ext = extOf(name);
  if (ext && EXT_CATEGORY[ext]) return EXT_CATEGORY[ext];
  return categoryForMime(mimeType) ?? "other";
}
