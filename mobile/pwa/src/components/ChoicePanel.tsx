/**
 * 对话内多题选择面板（手机端；与桌面端 ChoicePanel 同一契约）。
 *
 * 渲染在 assistant 消息的合法 ```choices 围栏处：每题点选一个选项（或「其它」
 * 自由文本），全部答完后点「发送选择」——所有答案合并成一条「我的选择：…」
 * 用户消息发出（followUp + 乐观回显）。该回复上屏后面板冻结并显示 ✓；若用户
 * 改用打字回答，则冻结为「已跳过」。状态从会话记录推导（见 lib/choice-block.ts），
 * 刷新/重连后保持一致。
 *
 * 草稿（未发送的点选）存 localStorage（按会话键，7 天过期清理）——PWA 被系统
 * 回收再打开时不丢已选项；发送成功后清除。
 */
import { useEffect, useMemo, useState } from "react";
import {
  buildChoiceReplyText,
  deriveChoicePanelState,
  type ChoiceAnswer,
  type ChoiceBlockData,
  type ChoiceTranscriptMessage,
} from "../lib/choice-block";

const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000; // 草稿 7 天过期（防 localStorage 堆积）

interface DraftEntry {
  answers: Partial<Record<number, ChoiceAnswer>>;
  ts: number;
}
type DraftMap = Record<string, DraftEntry>;

function draftKey(threadId: string): string {
  return `mpi-choice-drafts-${threadId}`;
}

function readDrafts(threadId: string): DraftMap {
  try {
    const raw = window.localStorage.getItem(draftKey(threadId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DraftMap;
    if (!parsed || typeof parsed !== "object") return {};
    const now = Date.now();
    let dirty = false;
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v.ts !== "number" || now - v.ts > DRAFT_TTL_MS) {
        delete parsed[k];
        dirty = true;
      }
    }
    if (dirty) window.localStorage.setItem(draftKey(threadId), JSON.stringify(parsed));
    return parsed;
  } catch {
    return {}; // 隐私模式/配额不可用——草稿退化为内存态
  }
}

function writeDrafts(threadId: string, map: DraftMap): void {
  try {
    if (Object.keys(map).length) window.localStorage.setItem(draftKey(threadId), JSON.stringify(map));
    else window.localStorage.removeItem(draftKey(threadId));
  } catch { /* ignore */ }
}

function isAnswered(a?: ChoiceAnswer): boolean {
  if (!a) return false;
  return a.kind === "option" ? !!a.label : !!a.text.trim();
}

/** 面板内的勾选图标（无图标库，手写最小 SVG）。 */
function IconCheck() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

export interface ChoicePanelProps {
  data: ChoiceBlockData;
  threadId: string;
  /** 携带该围栏的 assistant ViewMessage id（状态推导 + 草稿键）。 */
  messageId: string;
  /** 该文本块在消息内的序号（草稿键的一部分）。 */
  blockIndex: number;
  /** 该围栏在该文本块段序列中的下标（草稿键的一部分，与桌面端同口径）。 */
  panelIndex: number;
  /** 全量会话消息（含乐观回显）——状态推导用。 */
  messages: ChoiceTranscriptMessage[];
  /** 发送组合回复；失败时抛错（组件保留草稿并显示错误）。 */
  onSend: (text: string) => Promise<void>;
}

export function ChoicePanel({ data, threadId, messageId, blockIndex, panelIndex, messages, onSend }: ChoicePanelProps) {
  const panelKey = `${messageId}:${blockIndex}:${panelIndex}`;
  const [draft, setDraft] = useState<Partial<Record<number, ChoiceAnswer>>>(
    () => readDrafts(threadId)[panelKey]?.answers ?? {},
  );

  // 草稿落盘（按会话键合并写回，避免多面板互相覆盖）。
  useEffect(() => {
    const map = readDrafts(threadId);
    if (Object.keys(draft).length === 0) delete map[panelKey];
    else map[panelKey] = { answers: draft, ts: Date.now() };
    writeDrafts(threadId, map);
  }, [draft, threadId, panelKey]);

  const state = useMemo(() => deriveChoicePanelState(messages, messageId, data), [messages, messageId, data]);
  const frozen = state.kind !== "pending";

  // 本地 UI：细节展开 / 「其它」输入开合与内容 / 漏选提示 / 发送中。
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [otherOpen, setOtherOpen] = useState<Set<number>>(new Set());
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const [showMissing, setShowMissing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Effective answers: transcript-derived once frozen, drafts while pending.
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
    setDraft((prev) => ({ ...prev, [qi]: { kind: "option", label } }));
    setShowMissing(false);
    setError(null);
  };

  const openOther = (qi: number) => {
    if (frozen) return;
    const current = answers[qi];
    setOtherText((prev) => ({ ...prev, [qi]: current?.kind === "other" ? current.text : prev[qi] ?? "" }));
    setOtherOpen((prev) => new Set(prev).add(qi));
  };

  const closeOther = (qi: number) => {
    setOtherOpen((prev) => {
      const next = new Set(prev);
      next.delete(qi);
      return next;
    });
  };

  const confirmOther = (qi: number) => {
    if (frozen) return;
    const text = (otherText[qi] ?? "").trim();
    if (!text) return;
    setDraft((prev) => ({ ...prev, [qi]: { kind: "other", text } }));
    closeOther(qi);
    setShowMissing(false);
    setError(null);
  };

  const submit = async () => {
    if (frozen || sending) return;
    if (missingCount > 0) {
      setShowMissing(true);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSend(buildChoiceReplyText(data.questions, data.questions.map((_q, i) => answers[i] ?? null), "zh"));
      // 发送成功才清草稿（失败保留，重发不丢选择）。状态随后由会话推导冻结：
      // 乐观回显的用户消息已能解析成组合回复 → answered。
      setDraft({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`choice-panel state-${state.kind}`} role="group" aria-label="多题选择">
      <div className="cp-head">
        <span className="cp-kicker">多题选择</span>
        {frozen ? (
          <span className={`cp-status ${state.kind === "answered" ? "done" : ""}`}>
            {state.kind === "answered" ? "已完成" : "已跳过"}
          </span>
        ) : (
          <span className="cp-progress">已选 {answeredCount}/{data.questions.length}</span>
        )}
      </div>

      {data.questions.map((q, qi) => {
        const a = answers[qi];
        return (
          <div key={qi} className="cp-q">
            <div className="cp-q-title">
              <span className="cp-q-num">{qi + 1}</span>
              {q.title}
            </div>

            {q.options.map((opt) => {
              const selected = a?.kind === "option" && a.label === opt.label;
              const detailKey = `${qi}:${opt.label}`;
              const open = expanded.has(detailKey);
              return (
                <div key={detailKey}>
                  <div className={`cp-opt ${selected ? "selected" : ""}`}>
                    <button type="button" className="cp-opt-main" disabled={frozen} onClick={() => selectOption(qi, opt.label)}>
                      <span className="cp-radio">{selected && <IconCheck />}</span>
                      <span className="cp-opt-label">{opt.label}</span>
                    </button>
                    {opt.detail && (
                      <button type="button" className={`cp-detail-toggle ${open ? "open" : ""}`} onClick={() => toggleDetail(detailKey)}>
                        细节{open ? " ▴" : " ▾"}
                      </button>
                    )}
                  </div>
                  {opt.detail && open && <p className="cp-detail">{opt.detail}</p>}
                </div>
              );
            })}

            {/* 「其它」自由文本（与桌面端同一交互：点开后行内输入）。 */}
            {!frozen && a?.kind !== "other" && !otherOpen.has(qi) && (
              <button type="button" className="cp-opt cp-other-toggle" onClick={() => openOther(qi)}>
                <span className="cp-radio" />
                <span className="cp-opt-label">其它（输入自定义答案）…</span>
              </button>
            )}
            {!frozen && otherOpen.has(qi) && (
              <div className="cp-other">
                <input
                  type="text"
                  autoFocus
                  value={otherText[qi] ?? ""}
                  placeholder="输入自定义答案…"
                  onChange={(e) => setOtherText((prev) => ({ ...prev, [qi]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmOther(qi);
                    else if (e.key === "Escape") closeOther(qi);
                  }}
                />
                <div className="cp-other-row">
                  <button type="button" className="cp-btn" onClick={() => closeOther(qi)}>取消</button>
                  <button type="button" className="cp-btn primary" disabled={!(otherText[qi] ?? "").trim()} onClick={() => confirmOther(qi)}>
                    确认
                  </button>
                </div>
              </div>
            )}
            {a?.kind === "other" && (
              <div
                className={`cp-opt selected ${!frozen ? "editable" : ""}`}
                onClick={() => !frozen && openOther(qi)}
              >
                <span className="cp-radio">{frozen && <IconCheck />}</span>
                <span className="cp-opt-label">其它：{a.text}</span>
              </div>
            )}
          </div>
        );
      })}

      <div className="cp-foot">
        {showMissing && !frozen && missingCount > 0 ? (
          <p className="cp-missing" role="alert">还有 {missingCount} 题未选择</p>
        ) : error ? (
          <p className="cp-error">{error}</p>
        ) : null}
        {!frozen && (
          <button type="button" className="cp-submit" disabled={sending} onClick={() => void submit()}>
            {sending ? "发送中…" : "发送选择"}
          </button>
        )}
      </div>
    </div>
  );
}
