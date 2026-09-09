import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { PreviewPayload } from "../lib/types";
import { basename, fileIcon, formatBytes } from "../lib/format";
import { Close, Refresh } from "./icons";
import { PreviewBody } from "./Preview";

/** Content of a preview popped out into its own window (see #preview=<path>). */
export function StandalonePreview({ path }: { path: string }) {
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  // A dev instance started before the caption-move IPCs were added has no
  // previewWindowMoveStart in its preload — say so instead of failing silently.
  const [stalePreload, setStalePreload] = useState(false);
  useEffect(() => {
    if (typeof window.pi.app.previewWindowMoveStart !== "function") setStalePreload(true);
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

  // Caption drag (VS-style floating document window): main moves the window
  // with the cursor while we hold it; releasing over the main window docks the
  // file back into its preview panel and closes this window.
  const moveActiveRef = useRef(false);
  const onCaptionMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    moveActiveRef.current = true;
    void window.pi.app.previewWindowMoveStart(path).catch(() => {});
  };

  useEffect(() => {
    const endMove = () => {
      if (!moveActiveRef.current) return;
      moveActiveRef.current = false;
      void window.pi.app.previewWindowMoveEnd(path).catch(() => {});
    };
    // mouseup covers in-window releases; blur covers releasing over another
    // window (desktop, the main MPI window, ...) where we never get a mouseup.
    window.addEventListener("mouseup", endMove);
    window.addEventListener("blur", endMove);
    return () => {
      window.removeEventListener("mouseup", endMove);
      window.removeEventListener("blur", endMove);
    };
  }, [path]);

  const ext = (() => {
    const base = basename(path);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot).toLowerCase() : "";
  })();

  return (
    <div className="standalone-preview">
      {stalePreload && (
        <div className="standalone-stale-banner">
          {zh
            ? "停靠功能不可用：请完全退出并重启 MPI（当前实例的 preload 是旧版）"
            : "Docking unavailable: fully quit and restart MPI (this instance has an outdated preload)"}
        </div>
      )}
      {/* Custom caption (the window is frameless): drag anywhere on this row to
          move the window; release over the main window to dock back. */}
      <div className="standalone-caption" onMouseDown={onCaptionMouseDown}>
        <span className="preview-tab-ico">{fileIcon(ext, false)}</span>
        <span className="standalone-caption-title" title={path}>
          {basename(path)}
        </span>
        {payload && payload.kind !== "missing" && (
          <span className="muted standalone-caption-size">{formatBytes(payload.size)}</span>
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
