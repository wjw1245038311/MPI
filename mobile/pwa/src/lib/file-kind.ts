/**
 * 文件后缀 → 展示大类（`src/shared/file-kind.ts` 的 PWA 移植版）。
 *
 * 为什么是「源 + 副本」：PWA 是独立构建（vite root = mobile/pwa），跨 root import
 * 会被打包进 renderer 却又不方便单测；与 `lib/user-text.ts`（image-notes 的移植）
 * 同一约定。**两份必须给出相同分类**——`scripts/test-file-kind.mjs` 按同一批后缀
 * 逐条比对，改一处忘另一处会直接失败。
 *
 * 安卓那份在 `data/FileKinds.kt`（同一哨兵也覆盖它）。
 */

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

export const EXT_CATEGORY: Record<string, FileCategory> = {
  // 压缩包 / 安装包
  ".zip": "archive", ".rar": "archive", ".7z": "archive", ".tar": "archive", ".gz": "archive",
  ".tgz": "archive", ".bz2": "archive", ".xz": "archive", ".zst": "archive", ".iso": "archive",
  ".apk": "archive", ".jar": "archive", ".msi": "archive", ".exe": "archive", ".dmg": "archive",
  ".pkg": "archive", ".deb": "archive", ".rpm": "archive",

  ".pdf": "pdf",

  // Word 系（含 WPS 的 .wps 与 Apple 的 .pages）
  ".doc": "doc", ".docx": "doc", ".odt": "doc", ".rtf": "doc", ".wps": "doc", ".pages": "doc",

  // 表格
  ".xls": "sheet", ".xlsx": "sheet", ".csv": "sheet", ".tsv": "sheet", ".ods": "sheet", ".et": "sheet",
  ".numbers": "sheet",

  // 幻灯片
  ".ppt": "slide", ".pptx": "slide", ".odp": "slide", ".dps": "slide", ".key": "slide",

  // 代码 / 配置
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

  // 纯文本 / 日志
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

export function extOf(name: string | undefined | null): string {
  const value = String(name || "");
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const base = slash >= 0 ? value.slice(slash + 1) : value;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot).toLowerCase();
}

export function fileCategory(name?: string | null, mimeType?: string | null): FileCategory {
  const ext = extOf(name);
  if (ext && EXT_CATEGORY[ext]) return EXT_CATEGORY[ext];
  return categoryForMime(mimeType) ?? "other";
}
