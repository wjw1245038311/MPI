import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { IMAGE_COPY_SELECTOR, copyImageToClipboard } from "../lib/image-copy";
import { Copy } from "./icons";

/**
 * Global right-click menu for chat images (复制图片). One document-level
 * contextmenu listener covers every image matching IMAGE_COPY_SELECTOR — user
 * attachments, markdown imgs and the lightbox preview — without touching each
 * render site. The menu DOM only exists after a user interaction, so its
 * conditional labels are not exposed to the i18n stale-original trap (config is
 * long loaded by then).
 */
export function ImageCopyMenu() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pushToast = useStore((s) => s.pushToast);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!(el instanceof Element)) return;
      const img = el.closest(IMAGE_COPY_SELECTOR) as HTMLImageElement | null;
      if (!img) return;
      e.preventDefault();
      imgRef.current = img;
      setPos({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("contextmenu", onContext);
    return () => document.removeEventListener("contextmenu", onContext);
  }, []);

  useEffect(() => {
    if (!pos) return;
    const close = (e: MouseEvent) => {
      // Interactions inside the menu must not dismiss it.
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPos(null);
    };
    // Capture phase: some images stop mousedown propagation (lightbox), which
    // would otherwise keep the menu open when clicking them to dismiss.
    window.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pos]);

  const doCopy = async () => {
    const img = imgRef.current;
    setPos(null);
    if (!img) return;
    try {
      await copyImageToClipboard(img);
      pushToast("success", zh ? "图片已复制" : "Image copied");
    } catch (err: any) {
      const taint = /tainted|security/i.test(String(err?.message || err));
      pushToast(
        "error",
        zh
          ? taint
            ? "无法复制：跨域图片受浏览器安全限制"
            : "复制图片失败（图片可能尚未加载完成）"
          : taint
            ? "Cannot copy: cross-origin image is blocked by browser security"
            : "Could not copy the image (it may still be loading)"
      );
    }
  };

  if (!pos) return null;
  // Clamp so the menu never opens off-screen at a window edge.
  const W = 180;
  const H = 46;
  const x = Math.max(8, Math.min(pos.x, window.innerWidth - W - 8));
  const y = Math.max(8, Math.min(pos.y, window.innerHeight - H - 8));
  return (
    <div
      ref={menuRef}
      className="project-context-menu img-copy-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" onClick={() => void doCopy()}>
        <span>
          <Copy size={13} /> {zh ? "复制图片" : "Copy image"}
        </span>
      </button>
    </div>
  );
}
