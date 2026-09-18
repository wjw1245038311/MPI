import { useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import {
  buildChoiceReplyText,
  deriveChoicePanelState,
  type ChoiceAnswer,
  type ChoiceBlockData,
} from "../lib/choice-block";
import { Branch, Check, ChevronRight, Send } from "./icons";

const EMPTY_DRAFT: Partial<Record<number, ChoiceAnswer>> = {};

function isAnswered(a: ChoiceAnswer | undefined): boolean {
  if (!a) return false;
  return a.kind === "option" ? !!a.label : !!a.text.trim();
}

/**
 * Inline multi-question choice panel (对话内多题选择). Rendered in place of a
 * valid ```choices fence inside an assistant message. The user picks one
 * option per question locally; when every question has an answer, the submit
 * button combines all selections into ONE user message ("我的选择：…") via
 * sendPrompt. After that reply lands (or any other user message follows) the
 * panel freezes and shows the selections — state is derived from the
 * transcript, so reloads stay correct. See lib/choice-block.ts for the format
 * contract with the grilling skill / tool description.
 */
export function ChoicePanel({
  data,
  threadId,
  messageKey,
  panelIndex,
}: {
  data: ChoiceBlockData;
  threadId: string;
  /** Key of the assistant ViewMessage carrying this block. */
  messageKey: string;
  /** Index of this fence among the segments of that text block (panel key part). */
  panelIndex: number;
}) {
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";
  const messages = useStore((s) => s.threads[threadId]?.messages);
  const draft = useStore((s) => s.choiceDrafts[`${messageKey}:${panelIndex}`]) ?? EMPTY_DRAFT;
  const setChoiceDraft = useStore((s) => s.setChoiceDraft);
  const clearChoiceDraft = useStore((s) => s.clearChoiceDraft);
  const sendPrompt = useStore((s) => s.sendPrompt);

  const panelKey = `${messageKey}:${panelIndex}`;
  const state = useMemo(() => deriveChoicePanelState(messages, messageKey, data), [messages, messageKey, data]);
  const frozen = state.kind !== "pending";

  // Local UI: per-question detail expansion + “其它” input open/close.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [otherOpen, setOtherOpen] = useState<Set<number>>(new Set());
  const [showMissing, setShowMissing] = useState(false);
  const sectionRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Effective answers: the transcript-derived ones once frozen, drafts while pending.
  const answers: Partial<Record<number, ChoiceAnswer>> = state.kind === "answered" ? state.answers : draft;
  const answeredCount = data.questions.reduce((n, _q, i) => n + (isAnswered(answers[i]) ? 1 : 0), 0);
  const missingCount = data.questions.length - answeredCount;

  const toggleDetail = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectOption = (qi: number, label: string) => {
    if (frozen) return;
    setChoiceDraft(panelKey, qi, { kind: "option", label });
    setShowMissing(false);
  };

  const confirmOther = (qi: number, text: string) => {
    if (frozen || !text.trim()) return;
    setChoiceDraft(panelKey, qi, { kind: "other", text: text.trim() });
    setOtherOpen((prev) => {
      const next = new Set(prev);
      next.delete(qi);
      return next;
    });
    setShowMissing(false);
  };

  const submit = async () => {
    if (frozen) return;
    if (missingCount > 0) {
      // 漏选提示：highlight the unanswered questions and jump to the first one.
      setShowMissing(true);
      const firstMissing = data.questions.findIndex((_q, i) => !isAnswered(answers[i]));
      sectionRefs.current.get(firstMissing)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const text = buildChoiceReplyText(data.questions, data.questions.map((_q, i) => answers[i] ?? null), zh ? "zh" : "en");
    // Keep the draft until the send succeeds so a failed send loses nothing.
    // followUp: if the agent is still working (rare — it normally waits for
    // this answer), queue instead of steering/interrupting its current turn.
    const result = await sendPrompt(threadId, text, undefined, undefined, "followUp");
    if (result !== null) clearChoiceDraft(panelKey);
  };

  return (
    <div className={`choice-panel ${frozen ? `state-${state.kind}` : "state-pending"}`} role="group" aria-label={zh ? "多题选择" : "Multi-question choice"}>
      <div className="cp-head">
        <span className="cp-icon" aria-hidden="true"><Branch size={14} /></span>
        <span className="cp-kicker">{zh ? "多题选择" : "Multi choice"}</span>
        {frozen ? (
          <span className={`tool-status ${state.kind === "answered" ? "state-done" : ""}`}>
            {state.kind === "answered" ? (zh ? "已完成" : "Done") : zh ? "已跳过" : "Skipped"}
          </span>
        ) : (
          <span className="cp-progress">
            {zh ? `已选 ${answeredCount}/${data.questions.length}` : `${answeredCount} of ${data.questions.length} selected`}
          </span>
        )}
        {!frozen && (
          <button className="btn primary cp-submit" onClick={() => void submit()}>
            <Send size={13} /> {zh ? "发送选择" : "Send choices"}
          </button>
        )}
      </div>
      {showMissing && !frozen && missingCount > 0 && (
        <div className="cp-missing-hint" role="alert">
          {zh ? `还有 ${missingCount} 题未选择` : `${missingCount} question${missingCount === 1 ? "" : "s"} still need an answer`}
        </div>
      )}

      {data.questions.map((q, qi) => {
        const a = answers[qi];
        const missing = showMissing && !frozen && !isAnswered(a);
        return (
          <div
            key={qi}
            ref={(el) => {
              if (el) sectionRefs.current.set(qi, el);
              else sectionRefs.current.delete(qi);
            }}
            className={`cp-q ${missing ? "missing" : ""}`}
          >
            <div className="cp-q-title">
              <span className="cp-q-num">{qi + 1}</span>
              {q.title}
            </div>
            {/* extui-card-options: reuse the live card's option row styling. */}
            <div className="extui-card-options cp-options">
              {q.options.map((opt) => {
                const selected = a?.kind === "option" && a.label === opt.label;
                const detailKey = `${qi}:${opt.label}`;
                const isOpen = expanded.has(detailKey);
                return (
                  <div key={detailKey} className={`extui-opt ${selected ? "recommended" : ""}`}>
                    <div className="extui-opt-row">
                      <button
                        type="button"
                        className="extui-opt-label cp-opt-label"
                        disabled={frozen}
                        onClick={() => selectOption(qi, opt.label)}
                      >
                        {selected ? <Check size={13} /> : <span className="cp-radio" aria-hidden="true" />}
                        <span>{opt.label}</span>
                      </button>
                      {opt.detail && (
                        <button
                          type="button"
                          className={`opt-detail-toggle ${isOpen ? "open" : ""}`}
                          title={isOpen ? (zh ? "收起细节" : "Collapse details") : zh ? "展开细节" : "Expand details"}
                          onClick={() => toggleDetail(detailKey)}
                        >
                          {zh ? "细节" : "Detail"} <ChevronRight size={12} />
                        </button>
                      )}
                    </div>
                    {opt.detail && isOpen && <div className="opt-detail">{opt.detail}</div>}
                  </div>
                );
              })}

              {/* Per-question “其它” free text (same idea as the popup card). */}
              {!frozen && !otherOpen.has(qi) && a?.kind !== "other" && (
                <button type="button" className="extui-opt other-opt cp-other-toggle" onClick={() => setOtherOpen((prev) => new Set(prev).add(qi))}>
                  {zh ? "其它（输入自定义答案）…" : "Other — type your own answer…"}
                </button>
              )}
              {!frozen && otherOpen.has(qi) && (
                <div className="cp-other-input">
                  <CpOtherField
                    onConfirm={(text) => confirmOther(qi, text)}
                    onCancel={() =>
                      setOtherOpen((prev) => {
                        const next = new Set(prev);
                        next.delete(qi);
                        return next;
                      })
                    }
                    zh={zh}
                  />
                </div>
              )}
              {a?.kind === "other" && (
                <div
                  className={`extui-opt recommended cp-other-shown ${!frozen ? "editable" : ""}`}
                  title={!frozen ? (zh ? "点击修改自定义答案" : "Click to edit your custom answer") : undefined}
                  onClick={() => {
                    if (!frozen) setOtherOpen((prev) => new Set(prev).add(qi));
                  }}
                >
                  <div className="extui-opt-row">
                    <span className="cp-other-text">
                      {frozen && <Check size={13} />} {zh ? "其它：" : "Other: "} {a.text}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Small local-state input for a question's “其它” answer. */
function CpOtherField({ onConfirm, onCancel, zh }: { onConfirm: (text: string) => void; onCancel: () => void; zh: boolean }) {
  const [text, setText] = useState("");
  return (
    <>
      <input
        type="text"
        autoFocus
        className="cp-other-field"
        value={text}
        placeholder={zh ? "输入自定义答案…" : "Type your own answer…"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm(text);
          else if (e.key === "Escape") onCancel();
        }}
      />
      <div className="extui-card-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {zh ? "取消" : "Cancel"}
        </button>
        <button type="button" className="btn primary" disabled={!text.trim()} onClick={() => onConfirm(text)}>
          {zh ? "确认" : "OK"}
        </button>
      </div>
    </>
  );
}
