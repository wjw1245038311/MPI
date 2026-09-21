/**
 * 右侧侧板共用宽度逻辑（预览区 / 侧板）。
 *
 * 侧板槽是互斥的：同一时刻右侧只显示一个面板（预览或待办…）。它们共用
 * 同一个宽度持久化 key，因此切换面板时宽度保持一致，像同一个槽换了内容。
 *
 * 用法：`const { width, beginResize, resizeWithKeyboard, persistWidth } = useSidePanelWidth();`
 * `disabled` 传 true 时禁止拖拽（例如面板处于展开态）。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export const SIDE_PANEL_WIDTH_KEY = "mpi.preview-width";
export const SIDE_PANEL_DEFAULT_WIDTH = 420;
export const SIDE_PANEL_MIN_WIDTH = 300;
export const SIDE_PANEL_MAX_WIDTH = 900;

/** 夹在 [MIN, MAX] 与「窗口宽度 - 导航栏 - 主区最小宽」之间。 */
export function clampSidePanelWidth(width: number): number {
  const sidebarWidth = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect().width || 0;
  const available = Math.max(SIDE_PANEL_MIN_WIDTH, window.innerWidth - sidebarWidth - 320);
  return Math.min(Math.min(SIDE_PANEL_MAX_WIDTH, available), Math.max(SIDE_PANEL_MIN_WIDTH, width));
}

function readInitialWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDE_PANEL_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSidePanelWidth(saved) : clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH);
  } catch {
    return SIDE_PANEL_DEFAULT_WIDTH;
  }
}

export function useSidePanelWidth(disabled = false) {
  const [width, setWidth] = useState(readInitialWidth);
  const resizeRef = useRef<{ startX: number; startWidth: number; width: number; element: HTMLElement } | null>(null);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      drag.width = clampSidePanelWidth(drag.startWidth + drag.startX - event.clientX);
      setWidth(drag.width);
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      resizeRef.current = null;
      document.body.classList.remove("preview-resizing");
      if (drag.element.hasPointerCapture(event.pointerId)) drag.element.releasePointerCapture(event.pointerId);
      try {
        localStorage.setItem(SIDE_PANEL_WIDTH_KEY, String(Math.round(drag.width)));
      } catch {
        // 持久化不可用时拖拽本身仍可用。
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.body.classList.remove("preview-resizing");
    };
  }, []);

  const persistWidth = useCallback((next: number) => {
    const clamped = clampSidePanelWidth(next);
    setWidth(clamped);
    try {
      localStorage.setItem(SIDE_PANEL_WIDTH_KEY, String(Math.round(clamped)));
    } catch {
      // 同 pointer-up 的说明。
    }
  }, []);

  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || disabled) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeRef.current = {
        startX: event.clientX,
        startWidth: width,
        width,
        element: event.currentTarget,
      };
      document.body.classList.add("preview-resizing");
    },
    [disabled, width],
  );

  const resizeWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        persistWidth(width + 16);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        persistWidth(width - 16);
      } else if (event.key === "Home") {
        event.preventDefault();
        persistWidth(SIDE_PANEL_DEFAULT_WIDTH);
      }
    },
    [persistWidth, width],
  );

  return { width, beginResize, resizeWithKeyboard, persistWidth };
}
