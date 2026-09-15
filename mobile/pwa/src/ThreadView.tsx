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
import { compressImageFile, type CompressedImage } from "./lib/image-attach";
import { VoiceRecorder } from "./lib/voice-input";

/** Minimal inline icons for the composer (no icon dependency in the PWA). */
function IconPlus() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

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

  // T2 image attachments (max 3 — host's MAX_REMOTE_IMAGES).
  const [attachments, setAttachments] = useState<CompressedImage[]>([]);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const albumInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  // T5 voice input.
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);

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
    if (!actions || sending) return;
    if (!draft.trim() && !attachments.length) return;
    setSending(true);
    setSendError(null);
    try {
      await actions.send(draft, running ? "steer" : "prompt", attachments.length ? attachments : undefined);
      setDraft("");
      setAttachments([]);
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

  // ---- T2: image attachments -------------------------------------------------

  const pickImages = (source: "camera" | "album") => {
    setAttachMenuOpen(false);
    if (attachments.length >= 3) return;
    const input = source === "camera" ? cameraInputRef.current : albumInputRef.current;
    if (!input) return;
    // Reset so picking the same file again still fires change.
    input.value = "";
    void input.click();
  };

  const onFilesPicked = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const room = 3 - attachments.length;
    const list = Array.from(files).slice(0, Math.max(0, room));
    for (const file of list) {
      try {
        const image = await compressImageFile(file);
        setAttachments((prev) => (prev.length >= 3 ? prev : [...prev, image]));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSendError(`图片处理失败：${message}`);
      }
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  // ---- T5: voice input -------------------------------------------------------

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const rec = recorderRef.current;
      setRecSeconds(rec ? rec.elapsedSeconds() : 0);
    }, 500);
    return () => window.clearInterval(timer);
  }, [recording]);

  // Release the mic if the view unmounts mid-recording.
  useEffect(() => () => recorderRef.current?.cancel(), []);

  const startVoice = async () => {
    if (recording || transcribing) return;
    setSendError(null);
    try {
      const rec = new VoiceRecorder();
      await rec.start();
      recorderRef.current = rec;
      setRecSeconds(0);
      setRecording(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(`无法开始录音：${message}`);
    }
  };

  const stopVoice = async () => {
    const rec = recorderRef.current;
    if (!rec || !recording) return;
    setRecording(false);
    setTranscribing(true);
    setSendError(null);
    try {
      const { audioB64, sampleRate } = await rec.stop();
      recorderRef.current = null;
      if (!actions) throw new Error("连接未就绪");
      const result = await actions.transcribe(audioB64, sampleRate);
      const text = (result.text || "").trim();
      if (!text) {
        setSendError("没有识别到语音内容");
        return;
      }
      setDraft((prev) => (prev ? `${prev} ${text}` : text));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(`语音识别失败：${message}`);
    } finally {
      setTranscribing(false);
    }
  };

  const cancelVoice = () => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setRecording(false);
  };

  const fmtSeconds = (total: number) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;

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

          {/* Composer (Qoder-style card, 2026-09-15): + attachments / mic / round send-stop */}
          <div className="composer">
            {attachments.length > 0 && (
              <div className="attach-row">
                {attachments.map((attachment, i) => (
                  <span key={i} className="attach-chip">
                    <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="附件预览" />
                    <button type="button" className="attach-x" onClick={() => removeAttachment(i)} aria-label="移除图片">×</button>
                  </span>
                ))}
              </div>
            )}

            {recording ? (
              <div className="voice-row">
                <span className={`voice-dot ${transcribing ? "busy" : "live"}`} />
                <span className="voice-timer">{transcribing ? "识别中…" : `正在录音 ${fmtSeconds(recSeconds)}`}</span>
                <button type="button" className="voice-cancel" onClick={cancelVoice} disabled={transcribing}>取消</button>
                <button type="button" className="voice-done" onClick={() => void stopVoice()} disabled={transcribing}>完成</button>
              </div>
            ) : (
              <>
                <textarea
                  className="composer-input"
                  value={draft}
                  placeholder={running ? "引导当前任务…" : "描述你的任务…"}
                  rows={1}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void doSend();
                    }
                  }}
                />
                <div className="composer-row">
                  <button
                    type="button"
                    className={`icon-btn ${attachMenuOpen ? "active" : ""}`}
                    onClick={() => setAttachMenuOpen((open) => !open)}
                    disabled={attachments.length >= 3 || sending}
                    aria-label="添加图片"
                  >
                    <IconPlus />
                  </button>
                  {attachMenuOpen && (
                    <div className="attach-menu">
                      <button type="button" onClick={() => pickImages("camera")}>📷 拍照</button>
                      <button type="button" onClick={() => pickImages("album")}>🖼️ 相册</button>
                    </div>
                  )}
                  <span className="composer-spacer" />
                  <button
                    type="button"
                    className={`icon-btn ${transcribing ? "busy" : ""}`}
                    onClick={() => void startVoice()}
                    disabled={transcribing || sending}
                    aria-label="语音输入"
                  >
                    {transcribing ? <span className="spinner" /> : <IconMic />}
                  </button>
                  {running && (
                    <button type="button" className="send-btn stop" onClick={() => void doAbort()} disabled={sending} aria-label="停止">
                      <IconStop />
                    </button>
                  )}
                  <button
                    type="button"
                    className={`send-btn primary ${running ? "steer" : ""}`}
                    onClick={() => void doSend()}
                    disabled={sending || (!draft.trim() && !attachments.length)}
                    aria-label={running ? "引导发送" : "发送"}
                  >
                    <IconSend />
                  </button>
                </div>
              </>
            )}

            {/* Hidden pickers: album (multi) + camera (single, rear). */}
            <input ref={albumInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => void onFilesPicked(e.target.files)} />
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onFilesPicked(e.target.files)} />
          </div>
        </>
      )}

      {/* S6.3 approval card (full-screen, above everything) */}
      {view.pendingUi && <ApprovalCard request={view.pendingUi} busy={uiBusy} error={uiError} onRespond={onRespondUi} />}
    </div>
  );
}
