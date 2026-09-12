import type { TaskModeDef } from "../lib/types";
import { taskModeName, taskModeSummary } from "../lib/task-modes";
import { Close, Info } from "./icons";

/** Read-only detail view for a single task mode: parameters + behavioural
 * instructions + spec document path. Opened from the composer's mode dropdown
 * and the management dialog so users can read (“打开查看”) a mode's full
 * description without entering the edit form. */
export function TaskModeDetailModal({
  mode,
  language,
  onClose,
}: {
  mode: TaskModeDef;
  language: "zh" | "en";
  onClose: () => void;
}) {
  const zh = language === "zh";
  const spec = mode.specFile?.trim() || "";
  const instructions = mode.instructions?.trim() || "";

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal tm-modal tm-detail-modal">
        <div className="tm-head">
          <span className="tm-title">
            {taskModeName(mode, language)}
            {mode.builtin && <small className="tm-builtin">{zh ? "内置" : "Built-in"}</small>}
          </span>
          <button className="iconbtn" title={zh ? "关闭" : "Close"} onClick={onClose}>
            <Close size={15} />
          </button>
        </div>

        <p className="tm-hint">{taskModeSummary(mode, language)}</p>

        {mode.enforce === "readonly" && (
          <p className="tm-detail-note">
            <Info size={13} />{" "}
            {zh
              ? "强制只读：激活期间系统会拦截该会话的一切写操作（与权限级别无关）。"
              : "Enforced read-only: while active the system blocks every write in this thread (regardless of permission level)."}
          </p>
        )}

        <div className="tm-detail-section">
          <label>{zh ? "行为指令" : "Behavioural instructions"}</label>
          {instructions ? (
            <div className="tm-detail-text">{instructions}</div>
          ) : (
            <div className="tm-detail-text tm-detail-empty">
              {zh ? "无（该模式不注入额外指令）" : "None (this mode injects no extra instructions)"}
            </div>
          )}
        </div>

        <div className="tm-detail-section">
          <label>{zh ? "设计说明书" : "Spec document"}</label>
          {spec ? (
            <>
              <div className="tm-detail-text tm-detail-mono">{spec}</div>
              {spec.startsWith("@agent/") && (
                <small className="tm-hint">
                  {zh
                    ? "路径随 pi agent 目录解析（跨机器/用户通用）；文件缺失时本模式跳过注入。"
                    : "Resolved against pi's agent dir (portable across machines/users); if the file is missing, injection is skipped."}
                </small>
              )}
            </>
          ) : (
            <div className="tm-detail-text tm-detail-empty">{zh ? "无" : "None"}</div>
          )}
        </div>

        <div className="tm-actions">
          <button className="btn primary" onClick={onClose}>
            {zh ? "关闭" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
