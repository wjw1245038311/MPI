/**
 * 按文件类型画的彩色图标（PWA）。
 *
 * 与桌面 `src/renderer/src/components/FileTypeIcon.tsx` 的 `windows` 变体同源观感：
 * 白色页身 + 折角 + 左下角彩色徽标。手机上一律用彩色填充（用户 2026-11-04 选的），
 * 不用线条描边——小尺寸下描边会糊成一片。
 *
 * 为什么内联 SVG 而不是图标字体/位图：
 *   - 图标字体要额外加载字体文件，PWA 首屏多一个阻塞请求；
 *   - 位图无法跟随主题色，且 @2x/@3x 要多套文件；
 *   - 内联 SVG 只有几百字节，随组件走，缓存与主题都不用管。
 *
 * 分类全部来自 `lib/file-kind.ts`（与桌面/安卓同一批后缀）。
 */
import { fileCategory, type FileCategory } from "../lib/file-kind";

/** 每类的徽标底色（与桌面 FileTypeIcon 的 WIN_BADGES 对齐，视觉上像同一套图标）。 */
const BADGE_COLORS: Record<FileCategory, string | null> = {
  archive: "#8E8E93",
  pdf: "#E5484D",
  doc: "#2B7CD3",
  sheet: "#21A366",
  slide: "#E8590C",
  code: "#4C6EF5",
  text: null, // 纯文本：只有页身与横线，与桌面 text 一致
  image: "#4C9AFF",
  audio: "#AF52DE",
  video: "#FF9F0A",
  other: null,
};

/** 徽标里的字（有字画字，没字画笔形）。 */
const BADGE_LABELS: Partial<Record<FileCategory, string>> = {
  pdf: "PDF",
  doc: "W",
  sheet: "X",
  slide: "P",
};

/** 没有文字的类 → 用一段描边路径当徽标（与桌面的 glyph 同构）。 */
function badgeGlyph(cat: FileCategory): string | null {
  switch (cat) {
    case "archive":
      return "M5.5 14.6h5v4.4h-5z M5.5 16.7h5"; // 拉链/箱体
    case "code":
      return "m7.4 15.2-1.8 1.9 1.8 1.9M10.6 15.2l1.8 1.9-1.8 1.9";
    case "image":
      return "m5 18.6 1.9-2 1.4 1.4 1.6-1.6 1.8 1.9";
    case "audio":
      return "M8.6 14.5v4.6 M8.6 14.5l2.6-.6"; // 音符
    case "video":
      return "m6.4 15 2.6 1.5 2.6-1.5v3.2l-2.6 1.5-2.6-1.5z";
    default:
      return null;
  }
}

export function FileKindIcon({
  name,
  mimeType,
  size = 20,
}: {
  name?: string | null;
  /** 有的块只有 label、没有 mime（手机端老快照），此时只靠后缀判定。 */
  mimeType?: string | null;
  size?: number;
}) {
  const cat = fileCategory(name, mimeType);
  const color = BADGE_COLORS[cat];
  const label = BADGE_LABELS[cat];
  const glyph = color ? badgeGlyph(cat) : null;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`fkind fkind--${cat}`}
      aria-hidden="true"
      focusable="false"
    >
      {/* 页身 + 折角 */}
      <path
        d="M6.5 3h7L19 8.5V19a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
        fill="#fff"
        stroke="rgba(0,0,0,.22)"
        strokeWidth="1"
      />
      <path d="M13.5 3v4a1.5 1.5 0 0 0 1.5 1.5h4z" fill="#E9EBEF" stroke="rgba(0,0,0,.22)" strokeWidth="1" />
      {/* 纯文本 / 其它：只有页身横线，不加彩色块（跟着主题文字色走，不抢眼） */}
      {!color && <path d="M8.5 11h7M8.5 14h5" stroke="#C3C7CE" strokeWidth="1.1" strokeLinecap="round" fill="none" />}
      {color && (
        <>
          <rect x="3" y="12" width="9.5" height="9.5" rx="2" fill={color} stroke="#fff" strokeWidth="0.8" />
          {label ? (
            <text
              x="7.75"
              y="16.9"
              textAnchor="middle"
              dominantBaseline="central"
              fontFamily="Segoe UI, system-ui, Arial, sans-serif"
              fontWeight="700"
              fontSize={label.length > 1 ? 3.9 : 6.8}
              fill="#fff"
            >
              {label}
            </text>
          ) : (
            <path d={glyph ?? ""} stroke="#fff" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </>
      )}
    </svg>
  );
}
