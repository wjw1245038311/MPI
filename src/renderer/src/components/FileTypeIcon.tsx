import type { ReactNode } from "react";

/**
 * Modern line-style file-type icons (same stroke language as icons.tsx),
 * color-coded per category via .ficon--* CSS classes. Replaces the old emoji
 * set, which rendered inconsistently across platforms and themes.
 */
type Cat =
  | "dir"
  | "code"
  | "react"
  | "config"
  | "text"
  | "html"
  | "css"
  | "pdf"
  | "doc"
  | "sheet"
  | "slide"
  | "image"
  | "archive"
  | "file";

const EXT_CAT: Record<string, Cat> = {
  ".ts": "code", ".mts": "code", ".cts": "code", ".js": "code", ".mjs": "code", ".cjs": "code",
  ".py": "code", ".go": "code", ".rs": "code", ".java": "code", ".kt": "code", ".swift": "code",
  ".c": "code", ".h": "code", ".cpp": "code", ".hpp": "code", ".cs": "code", ".rb": "code",
  ".php": "code", ".sh": "code", ".bash": "code", ".zsh": "code", ".sql": "code",
  ".tsx": "react", ".jsx": "react",
  ".json": "config", ".yaml": "config", ".yml": "config", ".toml": "config", ".ini": "config",
  ".env": "config", ".xml": "config", ".lock": "config",
  ".md": "text", ".markdown": "text", ".txt": "text", ".log": "text", ".rst": "text",
  ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "css", ".less": "css",
  ".pdf": "pdf",
  ".docx": "doc", ".doc": "doc", ".odt": "doc", ".rtf": "doc",
  ".xlsx": "sheet", ".xls": "sheet", ".csv": "sheet", ".ods": "sheet",
  ".pptx": "slide", ".ppt": "slide", ".odp": "slide",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image",
  ".svg": "image", ".bmp": "image", ".ico": "image", ".avif": "image",
  ".zip": "archive", ".tar": "archive", ".gz": "archive", ".tgz": "archive", ".rar": "archive",
  ".7z": "archive", ".bz2": "archive",
};

/** macOS Finder-style colors: white page + folded corner + colored bottom band. */
const FINDER_COLORS: Record<Cat, string> = {
  dir: "#3693F3",
  code: "#5E5CE6",
  react: "#30B0C7",
  config: "#FFD60A",
  text: "#8E8E93",
  html: "#BF5AF2",
  css: "#64D2FF",
  pdf: "#FF3B30",
  doc: "#0A84FF",
  sheet: "#32D74B",
  slide: "#FF9F0A",
  image: "#FF375F",
  archive: "#A8A29E",
  file: "", // plain page, no band
};

function FinderGlyph({ cat, size }: { cat: Cat; size: number }) {
  if (cat === "dir") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className="ficon ficon--finder" aria-hidden>
        <path
          d="M3 7a2 2 0 0 1 2-2h4.2l1.8 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
          fill="#3693F3"
          stroke="rgba(0,0,0,.14)"
          strokeWidth="1"
        />
      </svg>
    );
  }
  const band = FINDER_COLORS[cat];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="ficon ficon--finder" aria-hidden>
      <path
        d="M6.5 3h7L19 8.5V19a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
        fill="#fff"
        stroke="rgba(0,0,0,.2)"
        strokeWidth="1"
      />
      <path d="M13.5 3v4a1.5 1.5 0 0 0 1.5 1.5h4z" fill="#E9EBEF" stroke="rgba(0,0,0,.2)" strokeWidth="1" />
      {band && <path d="M4.5 15.5h14V19a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2z" fill={band} />}
    </svg>
  );
}

/** Windows Explorer style: white page + folded corner + colored app badge (letter/glyph) bottom-left. */
type WinBadge = { color?: string; label?: string; fontSize?: number; glyph?: ReactNode };
const WIN_BADGES: Record<Cat, WinBadge> = {
  dir: {}, // yellow folder, handled separately
  code: {
    color: "#4C6EF5",
    glyph: <path d="m7.1 15-1.9 2 1.9 2M10.4 15l1.9 2-1.9 2" strokeWidth={1.5} />,
  },
  react: {
    color: "#1098AD",
    glyph: (
      <>
        <circle cx="7.75" cy="16.75" r="1" fill="#fff" stroke="none" />
        <ellipse cx="7.75" cy="16.75" rx="3.4" ry="1.5" strokeWidth={1.2} />
      </>
    ),
  },
  config: {
    color: "#F59F00",
    glyph: <path d="M8.7 14c-1.1 0-1.4.6-1.4 1.6v.8c0 .8-.3 1.2-1.2 1.3.9.1 1.2.5 1.2 1.3v.8c0 1 .3 1.6 1.4 1.6" strokeWidth={1.5} />,
  },
  text: {}, // plain page with faint lines, no badge
  html: {
    color: "#6F42C1",
    glyph: (
      <>
        <circle cx="7.75" cy="16.75" r="3.1" strokeWidth={1.2} />
        <path d="M4.7 16.75h6.1M7.75 13.7c1 .9 1.5 2.1 1.5 3s-.5 2.1-1.5 3c-1-.9-1.5-2.1-1.5-3s.5-2.1 1.5-3z" strokeWidth={1.2} />
      </>
    ),
  },
  css: { color: "#1CA7EC", label: "#", fontSize: 6.4 },
  pdf: { color: "#E5484D", label: "PDF", fontSize: 3.9 },
  doc: { color: "#2B7CD3", label: "W" },
  sheet: { color: "#21A366", label: "X" },
  slide: { color: "#E8590C", label: "P" },
  image: {
    color: "#4C9AFF",
    glyph: (
      <>
        <circle cx="6.3" cy="14.7" r=".9" fill="#fff" stroke="none" />
        <path d="m5 18.6 2-2.1 1.4 1.4 1.7-1.7 1.9 2" strokeWidth={1.3} />
      </>
    ),
  },
  archive: {
    color: "#8E8E93",
    glyph: (
      <>
        <rect x="5" y="14.4" width="5.5" height="4.7" rx="1" strokeWidth={1.2} />
        <path d="M5 16.4h5.5" strokeWidth={1.2} />
      </>
    ),
  },
  file: {}, // plain page, no badge
};

function WindowsGlyph({ cat, size }: { cat: Cat; size: number }) {
  if (cat === "dir") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className="ficon ficon--windows" aria-hidden>
        <path
          d="M3 7a2 2 0 0 1 2-2h4.2l1.8 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
          fill="#FFD34F"
          stroke="rgba(0,0,0,.18)"
          strokeWidth="1"
        />
      </svg>
    );
  }
  const badge = WIN_BADGES[cat];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="ficon ficon--windows" aria-hidden>
      <path
        d="M6.5 3h7L19 8.5V19a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
        fill="#fff"
        stroke="rgba(0,0,0,.2)"
        strokeWidth="1"
      />
      <path d="M13.5 3v4a1.5 1.5 0 0 0 1.5 1.5h4z" fill="#E9EBEF" stroke="rgba(0,0,0,.2)" strokeWidth="1" />
      <path d="M8.5 9.5h7M8.5 12h6" stroke="#D3D7DE" strokeWidth="1" strokeLinecap="round" fill="none" />
      {badge.color && (
        <>
          <rect x="3" y="12" width="9.5" height="9.5" rx="2" fill={badge.color} stroke="#fff" strokeWidth="0.8" />
          {badge.label ? (
            <text
              x="7.75"
              y="16.9"
              textAnchor="middle"
              dominantBaseline="central"
              fontFamily="Segoe UI, Arial, sans-serif"
              fontWeight={700}
              fontSize={badge.fontSize || 6.8}
              fill="#fff"
            >
              {badge.label}
            </text>
          ) : (
            <g stroke="#fff" fill="none" strokeLinecap="round" strokeLinejoin="round">
              {badge.glyph}
            </g>
          )}
        </>
      )}
    </svg>
  );
}

const FILE_OUTLINE = (
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </>
);

const GLYPHS: Record<Cat, ReactNode> = {
  dir: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  code: <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />,
  react: (
    <>
      <circle cx="12" cy="12" r="1.6" />
      <path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z" />
      <path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z" />
    </>
  ),
  config: (
    <>
      <path d="M9 4C7 4 6.5 5 6.5 7v2.5c0 1.5-.7 2.5-2.5 2.5 1.8 0 2.5 1 2.5 2.5V17c0 2 .5 3 2.5 3" />
      <path d="M15 4c2 0 2.5 1 2.5 3v2.5c0 1.5.7 2.5 2.5 2.5-1.8 0-2.5 1-2.5 2.5V17c0 2-.5 3-2.5 3" />
    </>
  ),
  text: (
    <>
      {FILE_OUTLINE}
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  html: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
    </>
  ),
  css: <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />,
  pdf: (
    <>
      {FILE_OUTLINE}
      <path d="M9 14h6" />
    </>
  ),
  doc: (
    <>
      {FILE_OUTLINE}
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  sheet: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 10h16M10 5v14" />
    </>
  ),
  slide: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v4M8 20h8" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.7" />
      <path d="m5 18 5-5 3 3 3-3 3 3" />
    </>
  ),
  archive: (
    <>
      <rect x="4" y="7" width="16" height="13" rx="2" />
      <path d="M4 7l2.2-3h11.6L20 7M10 12h4" />
    </>
  ),
  file: FILE_OUTLINE,
};

export function FileTypeIcon({
  ext,
  isDir = false,
  size = 14,
  variant = "windows",
}: {
  ext?: string;
  isDir?: boolean;
  size?: number;
  /** windows = Explorer app-badge docs; finder = macOS Finder filled documents; line = SF-Symbols strokes. */
  variant?: "line" | "finder" | "windows";
}) {
  const cat: Cat = isDir ? "dir" : EXT_CAT[(ext || "").toLowerCase()] || "file";
  if (variant === "windows") return <WindowsGlyph cat={cat} size={size} />;
  if (variant === "finder") return <FinderGlyph cat={cat} size={size} />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ficon ficon--${cat}`}
      aria-hidden
    >
      {GLYPHS[cat]}
    </svg>
  );
}
