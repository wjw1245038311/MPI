/**
 * Conversation view (S5/S6, docs/MOBILE-DESIGN.md §6.2).
 * Renders a ThreadSession snapshot: message blocks (text / thinking / tool / image),
 * the in-flight streaming tail, error banner, auto-scroll with "back to bottom".
 * S6 adds the send bar (prompt/steer + abort + sandbox/full toggle) and the
 * full-screen approval card (ui.request → ui.respond, §4.5 diff preview).
 */
import { useEffect, useRef, useState } from "react";
import type { RemotePermission, RemoteThreadState, RemoteUiRequest } from "../../shared/protocol";
import type { ThreadActions } from "./lib/thread-actions";
import type { ThreadView as ThreadViewState, ViewBlock, ViewMessage } from "./lib/thread-session";

const STATE_LABELS: Record<RemoteThreadState, string> = {
  draft: "草稿",
  idle: "空闲",
  running: "运行中",
  error: "出错",
  disconnected: "已断开",
};

/** §4.5 diff field shape (host attaches it to write/edit approval requests). */
interface ApprovalDiffView {
  path: string;
  added: number;
  removed: number;
  hunks: string;
}

function Block({ block }: { block: ViewBlock }) {
  if (block.type === "thinking") {
    return (
      <details className="msg-thinking">
        <summary>思考过程</summary>
        <pre>{block.text}</pre>
      </details>
    );
  }
  if (block.type === "tool") {
    return (
      <div className={`msg-tool ${block.running ? "running" : ""} ${block.isError ? "error" : ""}`}>
        <div className="msg-tool-head">
          <span className="msg-tool-name">{block.name || "tool"}</span>
          {block.argsText && <code className="msg-tool-args">{block.argsText}</code>}
          {block.running && <span className="spinner" aria-label="运行中" />}
        </div>
        {block.text ? (
          <details open={block.isError}>
            <summary>结果</summary>
            <pre>{block.text}</pre>
          </details>
        ) : null}
      </div>
    );
  }
  if (block.type === "image") {
    return block.data ? <img className="msg-image" src={block.data} alt={block.mimeType || "image"} /> : null;
  }
  return <p className="msg-text">{block.text}</p>;
}

function Message({ message }: { message: ViewMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`message ${isUser ? "user" : "assistant"}`}>
      {!isUser && message.blocks.length > 0 && (
        <div className="msg-role">
          MPI{message.stopReason === "error" ? " · 出错" : ""}
        </div>
      )}
      {message.blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
      {!isUser && message.artifacts && message.artifacts.length > 0 && (
        <div className="msg-artifacts">
          {message.artifacts.map((a) => (
            <span key={a.path} className={`artifact ${a.action}`}>
              {a.action === "created" ? "+" : "~"} {a.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** §4.5 diff preview: filename + "+N -M" stats + green/red lines (mono, h-scroll). */
function DiffPreview({ diff }: { diff: ApprovalDiffView }) {
  return (
    <div className="approval-diff">
      <div className="approval-diff-head">
        <code>{diff.path}</code>
        <span className="diff-stats">
          <em className="diff-add">+{diff.added}</em> <em className="diff-del">-{diff.removed}</em>
        </span>
      </div>
      <pre className="approval-diff-body">
        {diff.hunks.split("\n").map((line, i) => (
          <span key={i} className={line.startsWith("+") ? "diff-line-add" : line.startsWith("-") ? "diff-line-del" : undefined}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

/** Full-screen approval card for a pending ui.request (S6.3). */
function ApprovalCard({
  request,
  busy,
  error,
  onRespond,
}: {
  request: RemoteUiRequest;
  busy: boolean;
  error?: string | null;
  onRespond: (requestId: string, response: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(request.prefill || "");
  const diff = request.diff as ApprovalDiffView | undefined;
  const method = request.method;

  return (
    <div className="approval-backdrop">
      <div className="approval-card" role="dialog" aria-modal="true">
        <div className="approval-title">{request.title || "需要确认"}</div>
        {request.message && <p className="approval-msg">{request.message}</p>}

        {diff && diff.hunks ? <DiffPreview diff={diff} /> : null}

        {error && <p className="hint error-text">{error}</p>}

        {method === "select" && (
          <div className="approval-options">
            {(request.options || []).map((option) => (
              <button key={option} type="button" disabled={busy} onClick={() => onRespond(request.id, { value: option })}>
                {option}
              </button>
            ))}
          </div>
        )}

        {method === "confirm" && (
          <div className="approval-actions">
            <button type="button" disabled={busy} onClick={() => onRespond(request.id, { confirmed: false })}>
              拒绝
            </button>
            <button type="button" className="primary" disabled={busy} onClick={() => onRespond(request.id, { confirmed: true })}>
              允许
            </button>
          </div>
        )}

        {(method === "input" || method === "editor") && (
          <>
            <textarea
              className="approval-input"
              value={text}
              placeholder={request.placeholder || ""}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onRespond(request.id, { value: text });
                }
              }}
            />
            <div className="approval-actions">
              <button type="button" disabled={busy} onClick={() => onRespond(request.id, { cancelled: true })}>
                取消
              </button>
              <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => onRespond(request.id, { value: text })}>
                提交
              </button>
            </div>
          </>
        )}

        {/* Unknown methods (notify/setStatus etc. are filtered host-side; anything else degrades to cancel-only). */}
        {method !== "select" && method !== "confirm" && method !== "input" && method !== "editor" && (
          <div className="approval-actions">
            <button type="button" disabled={busy} onClick={() => onRespond(request.id, { cancelled: true })}>
              关闭
            </button>
          </div>
        )}

        {method === "select" || method === "confirm" ? (
          <button type="button" className="approval-cancel" disabled={busy} onClick={() => onRespond(request.id, { cancelled: true })}>
            取消
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface ThreadViewProps {
  view: ThreadViewState;
  actions: ThreadActions | null;
  uiBusy: boolean;
  uiError?: string | null;
  onRespondUi: (requestId: string, response: Record<string, unknown>) => void;
  onBack: () => void;
}

export default function ThreadView({ view, actions, uiBusy, uiError, onRespondUi, onBack }: ThreadViewProps) {
  const pendingUi = view.pendingUi;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Auto-scroll while the user is pinned to the bottom.
  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.messages, view.streaming, atBottom]);

  // Clear transient send errors when a new turn starts flowing.
  useEffect(() => {
    if (sendError && !view.running) setSendError(null);
  }, [view.running, sendError]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  const running = view.running || view.summary?.state === "running";

  const doSend = async () => {
    if (!actions || !draft.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await actions.send(draft, running ? "steer" : "prompt");
      setDraft("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(message.startsWith("THREAD_BUSY") ? "该会话正被其他设备操作，请稍后再试。" : `发送失败：${message}`);
    } finally {
      setSending(false);
    }
  };

  const doAbort = async () => {
    if (!actions || sending) return;
    setSendError(null);
    try {
      await actions.abort();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(message.startsWith("THREAD_BUSY") ? "该会话正被其他设备操作，无法停止。" : `停止失败：${message}`);
    }
  };

  const togglePermission = async () => {
    if (!actions || !view.summary) return;
    const next: RemotePermission = view.summary.permission === "sandbox" ? "full" : "sandbox";
    setSendError(null);
    try {
      await actions.setPermission(next); // snapshot update flows back via ThreadSession events
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(message.startsWith("THREAD_BUSY") ? "该会话正被其他设备操作，无法切换权限。" : `切换失败：${message}`);
    }
  };

  return (
    <div className="card thread-view">
      <div className="thread-head">
        <button type="button" className="back-btn" onClick={onBack} aria-label="返回项目列表">←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="thread-title">{view.summary?.title || "会话"}</div>
          {view.summary && (
            <>
              <span className={`badge badge-${view.summary.state}`}>{STATE_LABELS[view.summary.state]}</span>{" "}
              <button type="button" className="perm-chip" onClick={togglePermission} title="切换权限级别">
                {view.summary.permission === "sandbox" ? "沙盒" : "完整"}
              </button>
            </>
          )}
        </div>
      </div>

      {view.errorBanner && <p className="hint error-text">{view.errorBanner}</p>}
      {sendError && <p className="hint error-text">{sendError}</p>}

      {!view.ready ? (
        <p className="hint">加载会话…</p>
      ) : (
        <>
          <div className="thread-scroll" ref={scrollRef} onScroll={handleScroll}>
            {view.messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {view.streaming && <Message message={view.streaming} />}
            {running && !view.streaming && <p className="hint">正在工作…</p>}
          </div>
          {!atBottom && (
            <button type="button" className="to-bottom" onClick={scrollToBottom}>↓ 最新消息</button>
          )}

          {/* S6.2 send bar: idle → prompt, running → steer + abort */}
          <div className="send-bar">
            {running && (
              <button type="button" className="abort-btn" onClick={doAbort} disabled={sending}>
                停止
              </button>
            )}
            <textarea
              className="send-input"
              value={draft}
              placeholder={running ? "引导当前任务…" : "发送消息…"}
              rows={1}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void doSend();
                }
              }}
            />
            <button type="button" className="send-btn primary" onClick={() => void doSend()} disabled={sending || !draft.trim()}>
              {running ? "引导" : "发送"}
            </button>
          </div>
        </>
      )}

      {/* S6.3 approval card (full-screen, above everything) */}
      {view.pendingUi && <ApprovalCard request={view.pendingUi} busy={uiBusy} error={uiError} onRespond={onRespondUi} />}
    </div>
  );
}
