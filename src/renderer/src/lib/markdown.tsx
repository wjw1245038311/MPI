import { memo, useEffect, useMemo, useState, type ReactNode, type Ref } from "react";
import { renderMd } from "./md-pipeline";
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

// --- Mermaid diagrams -------------------------------------------------------
// ```mermaid fences render as SVG via the mermaid package — lazy-loaded so its
// ~400KB chunk only downloads when a diagram is actually present on screen.
let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
  if (!mermaidModulePromise) mermaidModulePromise = import("mermaid");
  return mermaidModulePromise;
}

let mermaidSeq = 0;
let mermaidInitializedTheme: string | null = null;

function MermaidDiagram({ code }: { code: string }) {
  const themePref = useStore((s) => s.config?.theme || "light");
  // Mirror App.tsx's resolution (config.theme; system → prefers-color-scheme).
  const [resolved, setResolved] = useState<"dark" | "light">(() =>
    themePref === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : (themePref as "dark" | "light"),
  );
  useEffect(() => {
    if (themePref !== "system") {
      setResolved(themePref);
      return;
    }
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(m.matches ? "dark" : "light");
    onChange();
    m.addEventListener?.("change", onChange);
    return () => m.removeEventListener?.("change", onChange);
  }, [themePref]);

  const [state, setState] = useState<{ status: "loading" | "ok" | "error"; svg?: string }>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    void (async () => {
      const id = `mpi-mermaid-${++mermaidSeq}`;
      try {
        const mermaid = (await loadMermaid()).default;
        if (mermaidInitializedTheme !== resolved) {
          // securityLevel strict sanitizes html labels — content may come from
          // agent output, so keep the default-safe setting.
          // suppressErrorRendering: without it, v12 draws its own giant red
          // “Syntax error” bomb SVG into a temp div in document.body on failed
          // renders and leaves that div behind (stray graphic at the window's
          // bottom-left) instead of throwing — we want our graceful raw-code
          // fallback below, so make render() throw on parse/draw errors.
          mermaid.initialize({
            startOnLoad: false,
            theme: resolved === "dark" ? "dark" : "default",
            securityLevel: "strict",
            suppressErrorRendering: true,
          });
          mermaidInitializedTheme = resolved;
        }
        const { svg } = await mermaid.render(id, code);
        if (alive) setState({ status: "ok", svg });
      } catch {
        // Defensive cleanup: a failed render can leave mermaid's temp container
        // (#d{id} / #i{id}) with an error graphic in document.body.
        for (const sel of [`#d${id}`, `#i${id}`]) {
          try {
            document.querySelector(sel)?.remove();
          } catch {
            /* ignore */
          }
        }
        if (alive) setState({ status: "error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, resolved]);

  const language = useStore((s) => s.config?.language || "en");
  if (state.status === "ok") {
    return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: state.svg! }} />;
  }
  if (state.status === "error") {
    return (
      <>
        <CodeBlock className="language-mermaid">{code}</CodeBlock>
        <div className="mermaid-error">
          {language === "zh" ? "Mermaid 语法错误，已显示原始代码。" : "Mermaid syntax error — showing raw code."}
        </div>
      </>
    );
  }
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">mermaid</span>
        <span className="spinner" />
      </div>
    </div>
  );
}

// 解析管线（插件列表 + processor + post）在 ./md-pipeline.ts——纯函数模块，
// 可被 node 测试直接 import 与 react-markdown 原库对拍。
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
    if (isBlock && /language-mermaid/i.test(className || "")) {
      return <MermaidDiagram code={extractText(children)} />;
    }
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

// --- Parse cache（切换会话重挂载免重复解析）---------------------------------
// 切换线程会卸载/重挂整条消息列表；没有缓存时每次切换都要对每个块重跑完整
// remark/rehype 管线（highlight.js 最重）——这是「切长会话慢」的主因。
// renderMd（./md-pipeline.ts，复刻 react-markdown v9 同步路径）的产物元素树是
// (text, fileBasePath, projectRoot) 的纯函数，按此缓存、跨挂载复用。

// components 按 (fileBasePath, projectRoot) 共享：缓存的元素树引用这些函数，
// identity 必须跨实例稳定（原实现是每实例 useMemo，效果相同但不共享）。
const mdComponentsCache = new Map<string, Record<string, unknown>>();
function getMdComponents(fileBasePath?: string | null, projectRoot?: string | null): Record<string, unknown> {
  const prefix = `${fileBasePath ?? ""}\u0001${projectRoot ?? ""}`;
  let c = mdComponentsCache.get(prefix);
  if (!c) {
    c = {
      ...MD_COMPONENTS,
      a: makeAnchorComponent(fileBasePath ?? undefined, projectRoot ?? undefined),
      img: makeImgComponent(fileBasePath ?? undefined, projectRoot ?? undefined),
    };
    if (mdComponentsCache.size >= 32) mdComponentsCache.clear(); // 前缀很少，简单重置封顶
    mdComponentsCache.set(prefix, c);
  }
  return c;
}

// LRU：外层 prefix → 内层 src → {len, node}；按缓存源文本总字节数封顶。
// 元素树比源文本重（约一个数量级），2MB 源 ≈ 可容纳数个长会话的热工作集。
const MD_PARSE_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const mdParseCache = new Map<string, Map<string, { len: number; node: ReactNode }>>();
let mdParseCacheBytes = 0;

function cachedRenderMd(src: string, prefix: string, components: Record<string, unknown>): ReactNode {
  let inner = mdParseCache.get(prefix);
  if (inner) {
    const hit = inner.get(src);
    if (hit) {
      // LRU touch：移到末尾（内层 + 外层）
      inner.delete(src);
      inner.set(src, hit);
      mdParseCache.delete(prefix);
      mdParseCache.set(prefix, inner);
      return hit.node;
    }
  } else {
    inner = new Map();
    mdParseCache.set(prefix, inner);
  }
  const node = renderMd(src, components);
  inner.set(src, { len: src.length, node });
  mdParseCacheBytes += src.length;
  while (mdParseCacheBytes > MD_PARSE_CACHE_MAX_BYTES) {
    // 从最旧的前缀里逐条淘汰（跨前缀近似 LRU，足够当内存护栏）
    const oldestPrefix = mdParseCache.keys().next();
    if (oldestPrefix.done) break;
    const oldestInner = mdParseCache.get(oldestPrefix.value)!;
    const oldestSrc = oldestInner.keys().next();
    if (oldestSrc.done) {
      mdParseCache.delete(oldestPrefix.value);
      continue;
    }
    const entry = oldestInner.get(oldestSrc.value)!;
    oldestInner.delete(oldestSrc.value);
    mdParseCacheBytes -= entry.len;
    if (!oldestInner.size) mdParseCache.delete(oldestPrefix.value);
  }
  return node;
}

export const Markdown = memo(
  function Markdown({
    text,
    containerRef,
    fileBasePath,
    projectRoot,
    noCache,
  }: {
    text: string;
    containerRef?: Ref<HTMLDivElement>;
    /** Absolute path of the on-disk .md being rendered (preview panel only) —
     *  enables relative links to open local files. */
    fileBasePath?: string | null;
    projectRoot?: string | null;
    /** 流式内容每个 tick 都在变：不入缓存，避免中间态挤掉已定稿条目。 */
    noCache?: boolean;
  }) {
    const src = text || "";
    const node = useMemo(() => {
      const components = getMdComponents(fileBasePath ?? undefined, projectRoot ?? undefined);
      if (noCache) return renderMd(src, components);
      return cachedRenderMd(src, `${fileBasePath ?? ""}\u0001${projectRoot ?? ""}`, components);
    }, [src, fileBasePath, projectRoot, noCache]);
    return <div className="md" ref={containerRef}>{node}</div>;
  },
);
