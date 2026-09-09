import { useCallback, useEffect, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { PreviewPayload } from "../lib/types";
import { basename, fileIcon, formatBytes } from "../lib/format";
import { MPI_FILE_MIME, MPI_PREVIEW_WINDOW_MIME } from "../lib/file-drag";
import { Close, Refresh } from "./icons";
import { PreviewBody } from "./Preview";

/** Content of a preview popped out into its own window (see #preview=<path>). */
export function StandalonePreview({ path }: { path: string }) {
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  // A dev instance started before the dock IPCs were added has no
  // previewWindowDragStart in its preload — say so instead of failing silently.
  const [stalePreload, setStalePreload] = useState(false);
  useEffect(() => {
    if (typeof window.pi.app.previewWindowDragStart !== "function") setStalePreload(true);
  }, []);

  useEffect(() => {
    // App-level theme/language normally come from the store; this window has no
    // store bootstrap, so read the config directly.
    window.pi.app
      .getConfig()
      .then((cfg: any) => {
        setLanguage(cfg?.language === "en" ? "en" : "zh");
        const theme = cfg?.theme || "light";
        if (theme !== "system") document.documentElement.dataset.theme = theme;
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPayload(await window.pi.app.readPreview(path));
    } catch (e: any) {
      setPayload({ name: basename(path), ext: "", size: 0, kind: "missing", message: e?.message || "read failed" });
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const zh = language === "zh";

  // Dragging this tab back into the main window docks it: the main panel
  // re-activates (or creates) the matching preview tab and closes this window.
  const onTabDragStart = (e: ReactDragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(MPI_FILE_MIME, path); // also works as a plain file drop
    e.dataTransfer.setData(MPI_PREVIEW_WINDOW_MIME, path); // dock-back marker
    // Cross-window drag payloads are unreliable; main tracks the pointer while
    // this drag is in flight and docks us back if it ends over the main window.
    void window.pi.app.previewWindowDragStart(path).catch(() => {});
  };

  const onTabDragEnd = () => {
    void window.pi.app.previewWindowDragEnd(path).catch(() => {});
  };

  const ext = (() => {
    const base = basename(path);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot).toLowerCase() : "";
  })();

  return (
    <div className="standalone-preview">
      <div className="preview-tabs standalone-tabs" role="tablist">
        <div
          className="preview-tab active"
          role="tab"
          aria-selected={true}
          title={`${zh ? "拖回主窗口的预览面板可停靠回来\n" : "Drag back onto the main window's preview panel to dock it back\n"}${path}`}
          draggable
          onDragStart={onTabDragStart}
          onDragEnd={onTabDragEnd}
        >
          <span className="preview-tab-ico">{fileIcon(ext, false)}</span>
          {loading && !payload ? <span className="spinner preview-tab-spinner" /> : null}
          <span className="preview-tab-name">{basename(path)}</span>
          <button
            className="preview-tab-close"
            aria-label={zh ? "关闭窗口" : "Close window"}
            onClick={() => window.close()}
          >
            <Close size={10} />
          </button>
        </div>
      </div>
      {stalePreload && (
        <div className="standalone-stale-banner">
          {zh
            ? "停靠功能不可用：请完全退出并重启 MPI（当前实例的 preload 是旧版）"
            : "Docking unavailable: fully quit and restart MPI (this instance has an outdated preload)"}
        </div>
      )}
      {/* The whole head row is a drag handle too — easier to grab than the tab. */}
      <div
        className="preview-head standalone-head"
        draggable
        onDragStart={onTabDragStart}
        onDragEnd={onTabDragEnd}
      >
        <span className="preview-title" title={path}>
          {basename(path)}
        </span>
        {payload && payload.kind !== "missing" && (
          <span className="muted preview-size">{formatBytes(payload.size)}</span>
        )}
        <button className="iconbtn" title={zh ? "刷新预览" : "Refresh preview"} disabled={loading} onClick={() => void load()}>
          <Refresh size={14} />
        </button>
        <button className="iconbtn" title={zh ? "关闭" : "Close"} onClick={() => window.close()}>
          <Close size={15} />
        </button>
      </div>
      <div className={`preview-body ${payload?.kind === "html" ? "html-preview-active" : ""}`}>
        {loading ? (
          <div className="pv-loading">
            <span className="spinner" />
          </div>
        ) : (
          <PreviewBody
            payload={payload}
            path={path}
            projectRoot={null}
            language={language}
            htmlAnnotationMode={false}
            htmlEditMode={false}
            onHtmlElementSelected={() => {}}
            onHtmlAnnotationModeChange={() => {}}
            onHtmlEditModeChange={() => {}}
          />
        )}
      </div>
    </div>
  );
}
