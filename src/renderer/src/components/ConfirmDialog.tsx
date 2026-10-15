import { useEffect } from "react";
import { useStore } from "../store";
import type { ConfirmAsk } from "../store";

/**
 * 全局确认框：由 `useStore.askConfirm()` 驱动，挂在 App 根部（和 Toasts 同级）。
 *
 * 不用原生 `window.confirm` —— Electron/Windows 上原生模态关掉后，输入框会夺不回
 * 鼠标焦点（用户反馈「批准后无法输入」）。所有删除 / 卸载 / 放弃未保存改动都走这里。
 *
 * 行为约定：
 *   - 点确认 → **先关窗再执行回调**，这样回调抛错或耗时都不会把对话框卡在屏上；
 *   - Esc / 点遮罩 = 取消（不执行回调）；
 *   - 焦点默认落在「取消」上，避免手按 Enter 直接确认破坏性操作。
 */
export function ConfirmDialog() {
  const ask = useStore((s) => s.confirmAsk);
  const close = useStore((s) => s.closeConfirm);
  const zh = useStore((s) => (s.config?.language || "en") === "zh");

  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    // capture 阶段拦下 Esc，别让背后的面板（搜索框、设置页）同时响应。
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ask, close]);

  if (!ask) return null;
  const run = (a: ConfirmAsk) => {
    close();
    void Promise.resolve(a.onConfirm()).catch(() => {
      /* 回调内部自己负责提示（多数是 pushToast），这里只保证不打断 UI */
    });
  };
  const confirmLabel = ask.confirmLabel || (ask.danger ? (zh ? "删除" : "Delete") : zh ? "确定" : "OK");
  const cancelLabel = ask.cancelLabel || (zh ? "取消" : "Cancel");

  return (
    <div className="confirm-layer" onMouseDown={() => close()}>
      <div
        className={`confirm-box${ask.danger ? " danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={ask.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-title">{ask.title}</div>
        {ask.body && <div className="confirm-body">{ask.body}</div>}
        <div className="confirm-btns">
          <button type="button" className="set-btn ghost" onClick={() => close()} autoFocus>
            {cancelLabel}
          </button>
          <button type="button" className={ask.danger ? "set-btn danger" : "set-btn primary"} onClick={() => run(ask)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
