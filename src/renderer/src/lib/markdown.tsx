import { memo, useEffect, useMemo, useState, type ReactNode, type Ref } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import { CODE_LANGUAGE_ALIASES, CODE_LANGUAGE_NAMES, CODE_LANGUAGES } from "./code-languages";
import { remarkTrimAutolinkTrailingUnicode } from "./remark-autolink-trim";
import { useStore } from "../store";

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in (node as any)) return extractText((node as any).props?.children);
  return "";
}

function CodeBlock({ className, children }: { className?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = useStore((s) => s.config?.language || "en");
  const lang = (className || "").match(/language-([\w-]+)/)?.[1] || "";
  const text = extractText(children);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{lang || "code"}</span>
        <button className="code-copy" onClick={copy} title={language === "zh" ? "复制" : "Copy"}>
          {copied ? (language === "zh" ? "已复制" : "Copied") : language === "zh" ? "复制" : "Copy"}
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

// Module-level constants: markdown parsing + highlight.js is the single most
// expensive thing the renderer does. ReactMarkdown re-initializes its plugin
// pipeline when the plugin array identity changes, and re-parses the text on
// every render — so everything here must be stable, and the component itself
// is memoized on `text`. Unchanged messages then cost nothing to re-render.
// The trim plugin must run after gfm (it fixes autolink literals gfm produced).
const REMARK_PLUGINS = [remarkGfm, remarkTrimAutolinkTrailingUnicode];

// rehype-raw enables inline HTML in markdown (READMEs use <table>/<img> for
// screenshot grids). Raw markup can carry event-handler attributes — react-
// markdown v9 does not filter those itself, so strip on* props before render.
function stripEventProps(node: any): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "element" && node.properties) {
    for (const key of Object.keys(node.properties)) {
      if (/^on/i.test(key)) delete node.properties[key];
    }
  }
  if (Array.isArray(node.children)) node.children.forEach(stripEventProps);
}
const rehypeStripEvents = () => (tree: any) => stripEventProps(tree);

const REHYPE_PLUGINS = [
  // Must run first: turns raw HTML text nodes into real elements so the rest
  // of the pipeline (and our component overrides, e.g. local <img>) sees them.
  rehypeRaw,
  rehypeStripEvents,
  // GitHub-style heading ids so in-document anchor links (e.g. the user
  // manual's table of contents) can jump to headings inside the app.
  rehypeSlug,
  [
    rehypeHighlight,
    {
      aliases: CODE_LANGUAGE_ALIASES,
      // Detect unlabeled fenced blocks after checking explicit languages. This
      // makes copied shell/code snippets useful while keeping the subset small.
      detect: true,
      languages: CODE_LANGUAGES,
      subset: CODE_LANGUAGE_NAMES,
    },
  ],
] as any;
// --- Local file link resolution (markdown previews of on-disk files) -------
// Relative links in a rendered .md should open the target file in the preview
// panel, not as a web page. Resolution order: directory of the md file first,
// then the project root (covers "repo-relative" links like the user manual's).
const platformSep = (): string => (/Win/.test(navigator.platform || "") ? "\\" : "/");

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Join a base dir with a relative path, resolving . / .. segments. */
function joinPath(base: string, rel: string): string {
  const parts = normalizeSlashes(base).split("/").filter(Boolean);
  for (const seg of normalizeSlashes(rel).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      // Never pop past a Windows drive root (e:/) or POSIX root (/).
      const last = parts[parts.length - 1];
      if (last && !/^[a-zA-Z]:$/.test(last)) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

/** Directory containing the rendered md file (null when not rendering a file). */
function dirOfFile(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = normalizeSlashes(p).split("/");
  parts.pop();
  return parts.join("/") || "/";
}

/** Candidate absolute paths for a local-file href, in resolution order:
 *  the md file's own directory first, then the project root. */
function localLinkCandidates(href: string, mdFileDir?: string | null, projectRoot?: string | null): string[] {
  const clean = (href.split("#")[0] || "").split("?")[0];
  if (!clean) return [];
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    /* malformed % sequence — use the raw value */
  }
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(decoded) || decoded.startsWith("/");
  if (isAbsolute) return [normalizeSlashes(decoded)];
  const out: string[] = [];
  for (const dir of [mdFileDir, projectRoot]) {
    if (!dir) continue;
    const candidate = joinPath(dir, decoded);
    if (!out.some((c) => c.toLowerCase() === candidate.toLowerCase())) out.push(candidate);
  }
  return out;
}

function makeAnchorComponent(fileBasePath?: string | null, projectRoot?: string | null) {
  return function Anchor({ href, children, ...rest }: any) {
    // Fragment links (#anchor) jump to headings inside the app instead of
    // opening a new window; everything else keeps target="_blank".
    const isFragment = typeof href === "string" && href.length > 1 && href.startsWith("#");
    return (
      <a
        href={href}
        {...rest}
        target={isFragment ? undefined : "_blank"}
        rel="noreferrer noopener"
        onClick={(e) => {
          if (!href || typeof href !== "string") return;
          if (/^https?:/i.test(href)) {
            e.preventDefault();
            window.open(href, "_blank");
            return;
          }
          if (isFragment) {
            e.preventDefault();
            // react-markdown percent-encodes non-ASCII in hrefs (#1-%E8%AE%A4…)
            // while rehype-slug keeps heading ids raw — decode before lookup.
            let id = href.slice(1);
            try {
              id = decodeURIComponent(id);
            } catch {
              /* malformed % sequence — fall back to the raw value */
            }
            const el = document.getElementById(id);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
          }
          // Other schemes (mailto:, tel:) keep the default browser behaviour.
          if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
          // Local file link — only meaningful when rendering an on-disk md
          // file; in chat messages there is no base dir, so leave as-is.
          const candidates = localLinkCandidates(href, dirOfFile(fileBasePath), projectRoot);
          if (!candidates.length) return;
          e.preventDefault();
          void (async () => {
            for (const candidate of candidates) {
              try {
                if (await window.pi.app.fileExists(candidate)) {
                  const sep = platformSep();
                  const abs = normalizeSlashes(candidate).split("/").join(sep);
                  useStore.getState().openPreview(abs, projectRoot ?? undefined);
                  return;
                }
              } catch {
                /* keep trying the next candidate */
              }
            }
            const zh = (useStore.getState().config?.language || "en") === "zh";
            useStore.getState().pushToast(
              "error",
              zh
                ? `文件不存在：${candidates[0].split("/").pop()}`
                : `File not found: ${candidates[0].split("/").pop()}`,
            );
          })();
        }}
      >
        {children}
      </a>
    );
  };
}

// --- Local images in markdown previews -------------------------------------
// Relative ![](img/x.png) refs resolve against the md file's directory (then
// project root), are read via IPC and inlined as data URLs — the renderer is
// served from http://(dev)/the app protocol, so a bare relative src would 404.
const mdImageDataCache = new Map<string, string>(); // path → data URL
const MD_IMAGE_CACHE_MAX = 40;

function LocalImage({
  src,
  alt,
  width,
  height,
  fileBasePath,
  projectRoot,
}: {
  src?: string;
  alt?: string;
  /** Raw-HTML <img width="100%"> support (README screenshot tables). */
  width?: string | number;
  height?: string | number;
  fileBasePath: string | null;
  projectRoot?: string | null;
}) {
  const hasSrc = typeof src === "string" && src.length > 0;
  const isRemote = hasSrc && /^(https?:|data:|blob:)/i.test(src);
  const mdFileDir = dirOfFile(fileBasePath);
  const candidates = useMemo(
    () => (hasSrc && !isRemote ? localLinkCandidates(src, mdFileDir, projectRoot) : []),
    [src, hasSrc, isRemote, mdFileDir, projectRoot],
  );
  // Synchronous cache check so re-renders don't flash an empty box.
  const [dataUrl, setDataUrl] = useState<string | null>(() => {
    for (const c of candidates) {
      const hit = mdImageDataCache.get(c);
      if (hit) return hit;
    }
    return null;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!candidates.length || dataUrl) return;
    let alive = true;
    void (async () => {
      for (const candidate of candidates) {
        if (mdImageDataCache.has(candidate)) continue;
        try {
          const img = await window.pi.app.readImageForMd?.(candidate);
          if (!img) continue; // missing / too big / not an image — try next
          const url = `data:${img.mime};base64,${img.base64}`;
          mdImageDataCache.set(candidate, url);
          if (mdImageDataCache.size > MD_IMAGE_CACHE_MAX) {
            // FIFO eviction — Map preserves insertion order.
            const first = mdImageDataCache.keys().next().value;
            if (first !== undefined) mdImageDataCache.delete(first);
          }
          if (alive) setDataUrl(url);
          return;
        } catch {
          /* try the next candidate */
        }
      }
      if (alive && !dataUrl) setFailed(true);
    })();
    return () => {
      alive = false;
    };
  }, [candidates, dataUrl]);

  if (isRemote || !hasSrc)
    return <img className="md-img" src={src} alt={alt || ""} width={width} height={height} />;
  if (dataUrl) return <img className="md-img" src={dataUrl} alt={alt || ""} width={width} height={height} />;
  if (failed) {
    const zh = (useStore.getState().config?.language || "en") === "zh";
    const name = (src || "").split(/[\\/]/).pop() || "";
    return (
      <div className="md-img-missing" title={src}>
        {alt ? `${alt}（${zh ? "图片加载失败" : "image failed to load"}）` : zh ? `图片不存在：${name}` : `Image not found: ${name}`}
      </div>
    );
  }
  return <img className="md-img md-img-loading" alt={alt || ""} />;
}

function makeImgComponent(fileBasePath?: string | null, projectRoot?: string | null) {
  return function Img({ src, alt, width, height }: any) {
    if (!fileBasePath)
      return <img className="md-img" src={src} alt={alt || ""} width={width} height={height} />;
    return (
      <LocalImage
        src={src}
        alt={alt}
        width={width}
        height={height}
        fileBasePath={fileBasePath}
        projectRoot={projectRoot ?? undefined}
      />
    );
  };
}

const MD_COMPONENTS = {
  pre: ({ children }: any) => <>{children}</>,
  code: ({ className, children, ...rest }: any) => {
    const isBlock = /hljs|language-/.test(className || "") || extractText(children).includes("\n");
    if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
    return (
      <code className="inline-code" {...rest}>
        {children}
      </code>
    );
  },
  table: ({ children }: any) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export const Markdown = memo(
  function Markdown({
    text,
    containerRef,
    fileBasePath,
    projectRoot,
  }: {
    text: string;
    containerRef?: Ref<HTMLDivElement>;
    /** Absolute path of the on-disk .md being rendered (preview panel only) —
     *  enables relative links to open local files. */
    fileBasePath?: string | null;
    projectRoot?: string | null;
  }) {
    // Per-instance anchor renderer; stable identity per (file, root) so chat
    // messages keep the zero-cost memoization of the shared components.
    const components = useMemo(
      () => ({
        ...MD_COMPONENTS,
        a: makeAnchorComponent(fileBasePath ?? undefined, projectRoot ?? undefined),
        img: makeImgComponent(fileBasePath ?? undefined, projectRoot ?? undefined),
      }),
      [fileBasePath, projectRoot],
    );
    return (
      <div className="md" ref={containerRef}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components as any}>
          {text || ""}
        </ReactMarkdown>
      </div>
    );
  },
);
