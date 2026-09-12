import { useEffect, useState } from "react";
import { choiceOptions, isChoiceTitle, stripChoicePrefix } from "../lib/choice";
import { useStore } from "../store";
import { Branch, ChevronRight, Close, Shield } from "./icons";

export function ExtUiPromptCard({ threadId }: { threadId: string }) {
  const item = useStore((s) =>
    s.extuiQueue.find(
      (queued) => queued.threadId === threadId && (queued.request.method === "confirm" || queued.request.method === "select"),
    ),
  );
  const respond = useStore((s) => s.respondExtUi);
  const language = useStore((s) => s.config?.language || "en");
  const request = item?.request;

  // Per-option “细节/Detail” expansion + the choice card's “其它/Other” input.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");

  // Reset local UI state whenever a different dialog takes the queue slot.
  useEffect(() => {
    setExpanded(new Set());
    setOtherOpen(false);
    setOtherText("");
  }, [request?.id]);

  useEffect(() => {
    if (!request?.timeout) return;
    const timer = setTimeout(
      () => respond(threadId, request.id, request.method === "confirm" ? { confirmed: false } : { cancelled: true }),
      request.timeout,
    );
    return () => clearTimeout(timer);
  }, [request?.id, request?.method, request?.timeout, respond, threadId]);

  if (!request) return null;
  const cancel = () =>
    respond(threadId, request.id, request.method === "confirm" ? { confirmed: false } : { cancelled: true });
  const fallbackTitle = language === "zh" ? "Pi 扩展" : "Pi extension";
  const rawTitle = String(request.title || fallbackTitle);
  // Plan-choice dialogs (mpi_ask_choice) lead with a stable prefix written by
  // the extension; keep in sync with src/main/choice-logic.ts.
  const isChoice = request.method === "select" && isChoiceTitle(rawTitle);
  const titleParts = rawTitle.split(/\r?\n/);
  let title = titleParts.shift() || fallbackTitle;
  if (isChoice) title = stripChoicePrefix(title);
  const detail = [...titleParts, request.message || ""].filter(Boolean).join("\n");
  // Permission-gate prompts (all modes) lead with a stable prefix; older builds
  // used the sandbox wording. Keep in sync with isSandboxApprovalRequest.
  const isSandbox = /^(?:权限确认|Permission\s+required|沙盒\s*请求授权|Sandbox\s+authorization|请求授权)\s*[:：]|sandbox|沙盒/i.test(title);

  return (
    <div className={`extui-card ${request.method} ${isSandbox ? "sandbox-card" : ""} ${isChoice ? "choice-card" : ""}`} role="alertdialog" aria-labelledby={`extui-title-${request.id}`}>
      <div className="extui-card-head">
        <div className="extui-card-heading">
          <span className="extui-card-icon" aria-hidden="true">{isChoice ? <Branch size={15} /> : <Shield size={15} />}</span>
          <div>
            <div className="extui-card-kicker">
              {isSandbox
                ? language === "zh" ? "权限确认" : "Permission required"
                : isChoice
                  ? language === "zh" ? "方案选择" : "Plan choice"
                  : request.method === "confirm"
                    ? language === "zh" ? "需要确认" : "Confirmation"
                    : language === "zh" ? "请选择" : "Choose an option"}
            </div>
            <div className="extui-card-title" id={`extui-title-${request.id}`}>{title}</div>
          </div>
        </div>
        <button
          className="extui-card-close"
          onClick={cancel}
          title={isChoice ? (language === "zh" ? "关闭（不选择）" : "Close (no selection)") : language === "zh" ? "拒绝并关闭" : "Deny and close"}
        >
          <Close size={14} />
        </button>
      </div>
      {detail && <div className="extui-card-message">{detail}</div>}
      {request.method === "confirm" ? (
        <div className="extui-card-actions">
          <button className="btn" onClick={cancel}>{language === "zh" ? "拒绝" : "Deny"}</button>
          <button className="btn primary" onClick={() => respond(threadId, request.id, { confirmed: true })}>
            {language === "zh" ? "仅允许本次" : "Allow once"}
          </button>
        </div>
      ) : (
        <div className="extui-card-options">
          {choiceOptions(request.options).map((opt, index) => {
            const deny = /^(deny|拒绝)$/i.test(opt.label);
            // The permission gate always lists its recommended action first;
            // plan-choice labels are agent-authored (a recommendation is
            // written into the label itself), so no auto-badge there.
            const recommended = !isChoice && index === 0;
            const isOpen = expanded.has(index);
            return (
              <div key={`${index}-${opt.label}`} className={`extui-opt ${recommended ? "recommended" : ""} ${deny ? "deny" : ""}`}>
                <div className="extui-opt-row">
                  <button className="extui-opt-label" onClick={() => respond(threadId, request.id, { value: opt.label })}>
                    <span>{opt.label}</span>
                    {recommended && <small>{language === "zh" ? "推荐" : "Recommended"}</small>}
                  </button>
                  {opt.detail && (
                    <button
                      className={`opt-detail-toggle ${isOpen ? "open" : ""}`}
                      title={isOpen ? (language === "zh" ? "收起细节" : "Collapse details") : language === "zh" ? "展开细节" : "Expand details"}
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                          return next;
                        })
                      }
                    >
                      {language === "zh" ? "细节" : "Detail"} <ChevronRight size={12} />
                    </button>
                  )}
                </div>
                {opt.detail && isOpen && <div className="opt-detail">{opt.detail}</div>}
              </div>
            );
          })}
          {/* Plan-choice cards only: let the user type a plan none of the
           * options cover. The typed text goes back through the same channel
           * as an option click, so the extension treats it as the selection. */}
          {isChoice && !otherOpen && (
            <button className="extui-opt other-opt" onClick={() => setOtherOpen(true)}>
              {language === "zh" ? "其它（输入自定义方案）…" : "Other — type your own plan…"}
            </button>
          )}
          {isChoice && otherOpen && (
            <div className="extui-other-input">
              <textarea
                autoFocus
                rows={3}
                value={otherText}
                placeholder={language === "zh" ? "描述你想要的方案（要点即可）…" : "Describe the plan you want (key points are fine)…"}
                onChange={(e) => setOtherText(e.target.value)}
              />
              <div className="extui-card-actions">
                <button className="btn" onClick={() => { setOtherOpen(false); setOtherText(""); }}>
                  {language === "zh" ? "取消" : "Cancel"}
                </button>
                <button
                  className="btn primary"
                  disabled={!otherText.trim()}
                  onClick={() => respond(threadId, request.id, { value: otherText.trim() })}
                >
                  {language === "zh" ? "确认提交" : "Submit"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
