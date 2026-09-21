import type { ReactNode } from "react";
import { useStore } from "../store";
import {
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  useSidePanelWidth,
} from "../lib/side-panel";
import { Close, Contract, Expand } from "./icons";

/**
 * 右侧侧板外壳：复用预览区的视觉与交互（拖宽 / 头部工具栏 / 边缘分隔）。
 * 只负责壳，内容由各面板作为 children 传入。右侧槽一次只显示一个面板，
 * 互斥由 store 的 openXxx() 与 App 的渲染逻辑保证。
 */
export function SidePanel({
  title,
  icon,
  onClose,
  children,
}: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const language = useStore((s) => s.config?.language || "en");
  const expanded = useStore((s) => s.sidePanelExpanded);
  const toggleExpanded = useStore((s) => s.toggleSidePanelExpanded);
  const { width, beginResize, resizeWithKeyboard, persistWidth } = useSidePanelWidth(expanded);

  return (
    <aside className="preview side-panel" style={expanded ? undefined : { width, flexBasis: width }}>
      {!expanded && (
        <div
          className="preview-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={language === "zh" ? "调整侧板宽度" : "Resize side panel"}
          aria-valuemin={SIDE_PANEL_MIN_WIDTH}
          aria-valuemax={SIDE_PANEL_MAX_WIDTH}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
          onDoubleClick={() => persistWidth(SIDE_PANEL_DEFAULT_WIDTH)}
          title={language === "zh" ? "拖动调整宽度；双击恢复默认" : "Drag to resize; double-click to reset"}
        />
      )}
      <header className="preview-head side-panel-head">
        <span className="side-panel-head-mark">{icon}</span>
        <span className="side-panel-head-title">{title}</span>
        <span className="preview-head-spacer" aria-hidden />
        {!expanded ? (
          <button
            className="iconbtn preview-expand-btn"
            title={language === "zh" ? "展开侧板" : "Expand panel"}
            aria-label={language === "zh" ? "展开侧板" : "Expand panel"}
            onClick={toggleExpanded}
          >
            <Expand size={15} />
          </button>
        ) : (
          <button
            className="iconbtn preview-collapse-btn"
            title={language === "zh" ? "收缩到侧栏" : "Restore side panel"}
            aria-label={language === "zh" ? "收缩到侧栏" : "Restore side panel"}
            onClick={toggleExpanded}
          >
            <Contract size={15} />
            <span>{language === "zh" ? "收缩" : "Restore"}</span>
          </button>
        )}
        <button
          className="iconbtn"
          title={language === "zh" ? "关闭" : "Close"}
          aria-label={language === "zh" ? "关闭" : "Close"}
          onClick={onClose}
        >
          <Close size={15} />
        </button>
      </header>
      <div className="side-panel-body">{children}</div>
    </aside>
  );
}
