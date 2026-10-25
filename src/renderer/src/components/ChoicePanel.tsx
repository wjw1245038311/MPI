import { useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import {
  buildChoiceReplyText,
  CHOICE_NOTE_MAX,
  deriveChoicePanelState,
  type ChoiceAnswer,
  type ChoiceBlockData,
} from "../lib/choice-block";
import { Branch, Check, ChevronRight, Send } from "./icons";

const EMPTY_DRAFT: Partial<Record<number, ChoiceAnswer>> = {};

function isAnswered(a: ChoiceAnswer | undefined): boolean {
  if (!a) return false;
  if (a.kind === "skip") return true; // 跳过也算处理过：不再拦「还有 N 题未选择」
  return a.kind === "option" ? !!a.label : !!a.text.trim();
}

/** 历史草稿/旧消息里仍可能带每题 note（旧格式）：换答案时保留，不主动清掉。 */
function noteOf(a: ChoiceAnswer | undefined): string {
  return a && "note" in a ? (a.note ?? "") : "";
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
 *
 * 每题标题右侧有「跳过」按钮（与「取消跳过」共用一个按钮）：跳过的题不回传给
 * 模型（整行省略）。面板底部有**整组**的「补充说明」，写在最后一题之后。
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

  // 本地 UI：细节展开 / 「其它」输入开合 / 整组补充说明 / 漏选提示
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [otherOpen, setOtherOpen] = useState<Set<number>>(new Set());
  const [panelNote, setPanelNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [showMissing, setShowMissing] = useState(false);
  const sectionRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Effective answers: the transcript-derived ones once frozen, drafts while pending.
  const answers: Partial<Record<number, ChoiceAnswer>> = state.kind === "answered" ? state.answers : draft;
  const answeredCount = data.questions.reduce((n, _q, i) => n + (isAnswered(answers[i]) ? 1 : 0), 0);
  const missingCount = data.questions.length - answeredCount;
  /** 冻结后显示历史里那条「补充：…」；提交前显示本地输入的。 */
  const shownNote = state.kind === "answered" ? (state.note ?? "") : panelNote;

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
    // 换答案时保留旧格式里已写的每题 note（UI 不再新写）。
    const note = noteOf(answers[qi]);
    setChoiceDraft(panelKey, qi, note ? { kind: "option", label, note } : { kind: "option", label });
    setShowMissing(false);
  };

  const confirmOther = (qi: number, text: string) => {
    if (frozen || !text.trim()) return;
    const note = noteOf(answers[qi]);
    const trimmed = text.trim();
    setChoiceDraft(panelKey, qi, note ? { kind: "other", text: trimmed, note } : { kind: "other", text: trimmed });
    setOtherOpen((prev) => {
      const next = new Set(prev);
      next.delete(qi);
      return next;
    });
    setShowMissing(false);
  };

  /** 跳过此题：不回传给模型（整行省略）；同一个按钮再点一次即取消跳过。 */
  const skipQuestion = (qi: number) => {
    if (frozen) return;
    setChoiceDraft(panelKey, qi, { kind: "skip" });
    setOtherOpen((prev) => {
      const next = new Set(prev);
      next.delete(qi);
      return next;
    });
    setShowMissing(false);
  };

  /** 取消跳过：清掉该题草稿，回到「未选」。 */
  const undoSkip = (qi: number) => {
    if (frozen) return;
    setChoiceDraft(panelKey, qi, null);
    setShowMissing(false);
  };

  const openNote = () => {
    setNoteDraft(shownNote);
    setNoteOpen(true);
  };

  const saveNote = () => {
    setPanelNote(noteDraft.slice(0, CHOICE_NOTE_MAX).trim());
    setNoteOpen(false);
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
    const text = buildChoiceReplyText(
      data.questions,
      data.questions.map((_q, i) => answers[i] ?? null),
      zh ? "zh" : "en",
      panelNote,
    );
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
      </div>

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
            className={`cp-q ${missing ? "missing" : ""} ${a?.kind === "skip" ? "skipped" : ""}`}
          >
            <div className="cp-q-title">
              <span className="cp-q-num">{qi + 1}</span>
              <span className="cp-q-title-text">{q.title}</span>
              {a?.kind === "skip" ? (
                frozen ? (
                  <span className="cp-skip-done">{zh ? "已跳过" : "Skipped"}</span>
                ) : (
                  <button type="button" className="cp-skip-btn" onClick={() => undoSkip(qi)}>
                    {zh ? "取消跳过" : "Undo skip"}
                  </button>
                )
              ) : (
                !frozen && (
                  <button type="button" className="cp-skip-btn" onClick={() => skipQuestion(qi)}>
                    {zh ? "跳过" : "Skip"}
                  </button>
                )
              )}
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
                    // 重新打开时预填上次输入，直接接着改。
                    initial={a?.kind === "other" ? a.text : ""}
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

      {/* 整组补充说明：与「其它」同款虚框；保存后仍以同款可见，点击可改。 */}
      {!frozen && noteOpen ? (
        <div className="cp-note-input">
          <div className="cp-note-input-head">{zh ? "补充说明" : "Note"}</div>
          <input
            type="text"
            autoFocus
            className="cp-note-field"
            value={noteDraft}
            maxLength={CHOICE_NOTE_MAX}
            placeholder={zh ? "其它补充…" : "Anything else…"}
            onChange={(e) => setNoteDraft(e.target.value.slice(0, CHOICE_NOTE_MAX))}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveNote();
              else if (e.key === "Escape") setNoteOpen(false);
            }}
          />
          <div className="cp-note-meta">
            <span>{noteDraft.length}/{CHOICE_NOTE_MAX}</span>
          </div>
          <div className="cp-note-actions">
            <button type="button" className="btn" onClick={() => setNoteOpen(false)}>
              {zh ? "取消" : "Cancel"}
            </button>
            <button type="button" className="btn primary" onClick={saveNote}>
              {zh ? "确认" : "OK"}
            </button>
          </div>
        </div>
      ) : shownNote ? (
        <div
          className="cp-note-entry has-note"
          title={!frozen ? (zh ? "点击修改补充说明" : "Click to edit the note") : undefined}
          onClick={() => !frozen && openNote()}
        >
          <span className="cp-note-entry-label">{zh ? "补充：" : "Note: "}{shownNote}</span>
        </div>
      ) : (
        !frozen && (
          <button type="button" className="cp-note-entry" onClick={openNote}>
            {zh ? "补充说明…" : "Add a note…"}
          </button>
        )
      )}

      {/* Submit lives at the END of the panel (after all questions); the
       * missing-answer hint sits beside it so it is visible on click. */}
      <div className="cp-foot">
        {showMissing && !frozen && missingCount > 0 && (
          <div className="cp-missing-hint" role="alert">
            {zh ? `还有 ${missingCount} 题未选择` : `${missingCount} question${missingCount === 1 ? "" : "s"} still need an answer`}
          </div>
        )}
        {!frozen && (
          <button className="btn primary cp-submit" onClick={() => void submit()}>
            <Send size={13} /> {zh ? "发送选择" : "Send choices"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Small local-state input for a question's “其它” answer.
 *  `initial` 让重新打开时可接着上次内容改（不再要求从头重输）。 */
function CpOtherField({
  initial,
  onConfirm,
  onCancel,
  zh,
}: {
  initial?: string;
  onConfirm: (text: string) => void;
  onCancel: () => void;
  zh: boolean;
}) {
  const [text, setText] = useState(initial ?? "");
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
