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
import { arrayBufferToBase64, VoiceRecorder } from "./lib/voice-input";

/** 主机侧上限（见 src/main/remote/service.ts MAX_REMOTE_FILES / MAX_REMOTE_FILE_DATA）。 */
const MAX_FILES = 3;
const MAX_FILE_BYTES = 6_000_000;

/** 一个待发送的文件附件（base64）。 */
interface PickedFile {
  name: string;
  mimeType: string;
  data: string;
  size: number;
}

const formatSize = (bytes: number): string =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;

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

/** 附件里的文件图标（无图标库，手写最小 SVG）。 */
function IconFile() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function IconX() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** 配置栏用：权限（锁）与模型（方框）。 */
function IconLock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function IconModel() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M9 15V9l3 3 3-3v6" />
    </svg>
  );
}

/** 配置栏用：任务模式（闪电）。 */
function IconSpark() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 3 5 14h5l-1 7 8-11h-5l1-7z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

/** 录音中的麦克风图标（波形）：图标本身就说明「正在采音」。 */
function IconWave() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M5 10v4M9.5 6v12M14.5 8v8M19 11v2" />
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
    // 折成一行：名称 + 参数摘要 + 状态点；点开才展开参数全文与结果。
    return (
      <details className={`msg-tool ${block.running ? "running" : ""} ${block.isError ? "error" : ""}`}>
        <summary className="msg-tool-head">
          <span className="msg-tool-state">
            {block.running ? <span className="spinner" aria-label="运行中" /> : block.isError ? "✗" : <IconCheck />}
          </span>
          <span className="msg-tool-name">{block.name || "tool"}</span>
          {block.argsText && <code className="msg-tool-args">{block.argsText}</code>}
        </summary>
        {block.argsText && <pre className="msg-tool-full">{block.argsText}</pre>}
        {block.text ? <pre>{block.text}</pre> : null}
      </details>
    );
  }
  if (block.type === "image") {
    return block.data ? <img className="msg-image" src={block.data} alt={block.mimeType || "image"} /> : null;
  }
  return <p className="msg-text">{block.text}</p>;
}

/** 草稿按会话存放（切走再回来、下拉刷新都不丢）。 */
function draftKey(threadId: string): string {
  return `mpi-draft-${threadId}`;
}

function readDraft(threadId: string): string {
  try {
    return window.localStorage.getItem(draftKey(threadId)) ?? "";
  } catch {
    return ""; // 隐私模式/配额不可用——草稿退化为内存态
  }
}

/** 可复制的纯文本：消息里所有 text 块（不含思考/工具）。 */
function messageText(message: ViewMessage): string {
  return message.blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function Message({ message, onCopied }: { message: ViewMessage; onCopied?: (ok: boolean) => void }) {
  const isUser = message.role === "user";
  // 长按复制（600ms）：手机上选中文本很难，复制整条消息反而常用。
  const pressTimer = useRef<number | null>(null);
  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  const beginPress = () => {
    if (!onCopied) return;
    const text = messageText(message);
    if (!text) return;
    cancelPress();
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      const done = () => onCopied(true);
      const fail = () => onCopied(false);
      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, fail);
      else fail();
    }, 600);
  };
  return (
    <div
      className={`message ${isUser ? "user" : "assistant"}`}
      onTouchStart={beginPress}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onContextMenu={(e) => {
        // 桌面/长按菜单：同样走复制，避免弹出没有复制项的菜单。
        if (!onCopied) return;
        const text = messageText(message);
        if (!text) return;
        e.preventDefault();
        void navigator.clipboard?.writeText(text).then(() => onCopied(true), () => onCopied(false));
      }}
    >
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // 草稿按会话保存（localStorage）：切走再回来、下拉刷新都不丢。
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // 顶部配置抽屉（权限/模式/模型）与瞬时提示。
  const [sheet, setSheet] = useState<null | "permission" | "mode" | "model">(null);
  const [toast, setToast] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);

  // T2 image attachments (max 3 — host's MAX_REMOTE_IMAGES) + T7 file attachments
  // (max 3 — host's MAX_REMOTE_FILES).
  const [attachments, setAttachments] = useState<CompressedImage[]>([]);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const albumInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // T5 voice input.
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  // 切会话：载入该会话的草稿 + 把顶层配置回收到当前快照值。
  const threadIdRef = useRef(view.threadId);
  useEffect(() => {
    if (threadIdRef.current === view.threadId) return;
    threadIdRef.current = view.threadId;
    setDraft(readDraft(view.threadId));
    setSendError(null);
    setAttachments([]);
    setSheet(null);
  }, [view.threadId]);

  // 首次挂载：读回本会话草稿。
  useEffect(() => {
    setDraft(readDraft(threadIdRef.current));
  }, []);

  // 草稿落盘（按会话键）+ 输入框自动增高（1–6 行，CSS 里也限了 max-height）。
  // 切会话那一帧里 draft 还是上一会话的值，先跳过（否则会把旧草稿写到新会话键上）。
  const persistKeyRef = useRef(view.threadId);
  useEffect(() => {
    if (persistKeyRef.current !== view.threadId) {
      persistKeyRef.current = view.threadId;
    } else {
      try {
        if (draft) window.localStorage.setItem(draftKey(view.threadId), draft);
        else window.localStorage.removeItem(draftKey(view.threadId));
      } catch {
        // 隐私模式/配额满——草稿退化为内存态，不影响发送
      }
    }
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
    }
  }, [draft, view.threadId]);

  // 瞬时提示自动消失。
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Auto-scroll while the user is pinned to the bottom.
  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.messages, view.streaming, atBottom]);

  // NOTE: no auto-clear of sendError here — an earlier version cleared it while
  // NOT running, which made mic/STT failures invisible (set → instantly wiped).
  // Errors now persist until the next user action (each handler clears on start).

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
    if (!draft.trim() && !attachments.length && !files.length) return;
    setSending(true);
    setSendError(null);
    try {
      await actions.send(
        draft,
        running ? "steer" : "prompt",
        attachments.length ? attachments : undefined,
        files.length ? files.map((f) => ({ name: f.name, mimeType: f.mimeType, data: f.data })) : undefined,
      );
      setDraft("");
      setAttachments([]);
      setFiles([]);
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

  /** 任意文件（PDF/日志/压缩包…）：原样 base64 上传，主机落盘后交给 agent 自己读。 */
  const pickFiles = () => {
    setAttachMenuOpen(false);
    if (files.length >= MAX_FILES) return;
    const input = fileInputRef.current;
    if (!input) return;
    input.value = "";
    void input.click();
  };

  const onFilesPicked = async (list: FileList | null) => {
    if (!list || !list.length) return;
    for (const file of Array.from(list)) {
      // 图片走压缩通道（模型直接看图）；其余原样上传。
      if (file.type.startsWith("image/")) {
        if (attachments.length >= 3) continue;
        try {
          const image = await compressImageFile(file);
          setAttachments((prev) => (prev.length >= 3 ? prev : [...prev, image]));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setSendError(`图片处理失败：${message}`);
        }
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setSendError(`文件过大：${file.name}（上限 ${Math.round(MAX_FILE_BYTES / 1_000_000)}MB）`);
        continue;
      }
      try {
        const data = arrayBufferToBase64(await file.arrayBuffer());
        setFiles((prev) =>
          prev.length >= MAX_FILES
            ? prev
            : [...prev, { name: file.name || "file", mimeType: file.type || "application/octet-stream", data, size: file.size }],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSendError(`文件读取失败：${message}`);
      }
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // ---- T5: voice input -------------------------------------------------------

  // Release the mic if the view unmounts mid-recording.
  useEffect(() => () => recorderRef.current?.cancel(), []);

  const startVoice = async () => {
    if (recording || transcribing) return;
    setSendError(null);
    let rec: VoiceRecorder | null = null;
    try {
      rec = new VoiceRecorder();
      await rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch (error) {
      // Release anything partially acquired — a leaked stream keeps the device
      // busy and makes every retry fail with "Could not start audio source".
      rec?.cancel();
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

  const togglePermission = async () => {
    if (!actions || !view.summary) return;
    const next: RemotePermission = view.summary.permission === "sandbox" ? "full" : "sandbox";
    setSendError(null);
    setSheet(null);
    try {
      await actions.setPermission(next); // snapshot update flows back via ThreadSession events
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(message.startsWith("THREAD_BUSY") ? "该会话正被其他设备操作，无法切换权限。" : `切换失败：${message}`);
    }
  };

  /** 选模型：host 校验并返回新快照；无 model_changed 事件，所以本地先更新徽标。 */
  const chooseModel = async (provider: string, modelId: string) => {
    if (!actions || modelBusy) return;
    setModelBusy(true);
    setSendError(null);
    try {
      await actions.setModel(provider, modelId);
      setSheet(null);
      setToast("模型已切换");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(message.startsWith("THREAD_BUSY") ? "该会话正被其他设备操作，无法切换模型。" : `模型切换失败：${message}`);
    } finally {
      setModelBusy(false);
    }
  };

  /** 选模式：host 应用（权限+思考+行为内容）并广播 config_changed，chip 随之更新。 */
  const chooseMode = async (modeId: string) => {
    if (!actions || modelBusy) return;
    setModelBusy(true);
    setSendError(null);
    try {
      await actions.setMode(modeId);
      setSheet(null);
      setToast("模式已切换");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(
        message.startsWith("THREAD_BUSY")
          ? "该会话正被其他设备操作，无法切换模式。"
          : message.startsWith("MODE_UNAVAILABLE")
            ? "主机上已没有这个模式（可能刚被删除）。"
            : `模式切换失败：${message}`,
      );
    } finally {
      setModelBusy(false);
    }
  };

  const modeLabel = (() => {
    const current = view.taskMode;
    if (!current) return "基线";
    const option = view.availableModes.find((m) => m.id === current);
    return option?.name || current;
  })();

  const modelLabel = (() => {
    const current = view.model;
    if (!current) return "默认模型";
    const option = view.availableModels.find((m) => m.provider === current.provider && m.id === current.id);
    const short = (option?.name || option?.id || current.id).split("/").pop() || current.id;
    return short.length > 18 ? `${short.slice(0, 17)}…` : short;
  })();

  return (
    <div className="thread-view">
      {/* 工具栏：返回 + 状态 + 会话级配置（权限/模式/模型）。
          原先这里还有一行重复的会话标题——顶部 header 已经显示同一个标题，删掉省一行。 */}
      <div className="thread-toolbar">
        <button type="button" className="back-btn" onClick={onBack} aria-label="返回项目列表">←</button>
        {view.summary && STATE_LABELS[view.summary.state] !== STATE_LABELS.idle && view.summary.state !== "draft" && (
          <span className={`badge badge-${view.summary.state}`}>{STATE_LABELS[view.summary.state]}</span>
        )}
        {view.summary && (
          <>
            <button
              type="button"
              className={`cfg-chip ${view.summary.permission === "sandbox" ? "sandbox" : "full"}`}
              onClick={() => setSheet("permission")}
            >
              <IconLock />
              {view.summary.permission === "sandbox" ? "沙盒" : "完整权限"}
            </button>
            <button type="button" className="cfg-chip" onClick={() => setSheet("mode")} disabled={modelBusy}>
              <IconSpark />
              {modeLabel}
            </button>
            <button type="button" className="cfg-chip" onClick={() => setSheet("model")} disabled={modelBusy}>
              <IconModel />
              {modelBusy ? "切换中…" : modelLabel}
            </button>
          </>
        )}
      </div>

      {!view.ready ? (
        <p className="hint">加载会话…</p>
      ) : (
        <>
          <div className="thread-scroll" ref={scrollRef} onScroll={handleScroll}>
            {view.messages.map((message) => (
              <Message key={message.id} message={message} onCopied={(ok) => setToast(ok ? "已复制" : "复制失败")} />
            ))}
            {view.streaming && <Message message={view.streaming} />}
            {running && !view.streaming && <p className="hint">正在工作…</p>}
          </div>
          {!atBottom && (
            <button type="button" className="to-bottom" onClick={scrollToBottom}>↓ 最新消息</button>
          )}

          {/* 错误提示贴着输入框——这里才是手指所在的位置。 */}
          {(sendError || view.errorBanner) && (
            <p className="hint error-text composer-error">{sendError || view.errorBanner}</p>
          )}

          {/* Composer：常驻按钮（附件/录音/停止/发送）。录音不改布局，只改按钮态。 */}
          <div className={`composer ${recording ? "recording" : ""}`}>
            {(attachments.length > 0 || files.length > 0) && (
              <div className="attach-row">
                {attachments.map((attachment, i) => (
                  <span key={i} className="attach-chip">
                    <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="附件预览" />
                    <button type="button" className="attach-x" onClick={() => removeAttachment(i)} aria-label="移除图片">×</button>
                  </span>
                ))}
                {files.map((file, i) => (
                  <span key={`f${i}`} className="attach-chip file" title={`${file.name} · ${formatSize(file.size)}`}>
                    <IconFile />
                    <span className="file-name">{file.name}</span>
                    <button type="button" className="attach-x" onClick={() => removeFile(i)} aria-label="移除文件">×</button>
                  </span>
                ))}
              </div>
            )}

            <textarea
              ref={inputRef}
              className="composer-input"
              value={draft}
              placeholder={
                recording ? "正在录音…点麦克风结束并转文字" : running ? "引导当前任务…" : "描述你的任务…"
              }
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
              {recording ? (
                // 录音中：左取消、右结束（微信式：同一位置再点一下即完成）
                <button type="button" className="icon-btn" onClick={cancelVoice} disabled={transcribing} aria-label="取消录音">
                  <IconX />
                </button>
              ) : (
                <button
                  type="button"
                  className={`icon-btn ${attachMenuOpen ? "active" : ""}`}
                  onClick={() => setAttachMenuOpen((open) => !open)}
                  disabled={(attachments.length >= 3 && files.length >= MAX_FILES) || sending}
                  aria-label="添加附件"
                >
                  <IconPlus />
                </button>
              )}
              {attachMenuOpen && !recording && (
                <div className="attach-menu">
                  <button type="button" onClick={() => pickImages("camera")}>📷 拍照</button>
                  <button type="button" onClick={() => pickImages("album")}>🖼️ 相册</button>
                  <button type="button" onClick={() => pickFiles()}>📎 文件</button>
                </div>
              )}
              <span className="composer-spacer" />
              <button
                type="button"
                className={`icon-btn mic ${recording ? "live" : ""} ${transcribing ? "busy" : ""}`}
                onClick={() => (recording ? void stopVoice() : void startVoice())}
                disabled={transcribing || sending}
                aria-label={recording ? "结束录音并转文字" : "语音输入"}
              >
                {transcribing ? <span className="spinner" /> : recording ? <IconWave /> : <IconMic />}
              </button>
              {running && !recording && (
                <button type="button" className="send-btn stop" onClick={() => void doAbort()} disabled={sending} aria-label="停止">
                  <IconStop />
                </button>
              )}
              {!recording && (
                <button
                  type="button"
                  className={`send-btn primary ${running ? "steer" : ""}`}
                  onClick={() => void doSend()}
                  disabled={sending || (!draft.trim() && !attachments.length && !files.length)}
                  aria-label={running ? "引导发送" : "发送"}
                >
                  <IconSend />
                </button>
              )}
            </div>

            {/* Hidden pickers: album (multi) + camera (single, rear) + 任意文件。 */}
            <input ref={albumInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => void onFilesPicked(e.target.files)} />
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onFilesPicked(e.target.files)} />
            <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => void onFilesPicked(e.target.files)} />
          </div>
        </>
      )}

      {/* 底部抽屉：权限 / 模型（会话级配置只在这里改，不占消息区）。 */}
      {sheet && (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="sheet-grip" />
            {sheet === "mode" ? (
              <>
                <div className="sheet-title">任务模式</div>
                <p className="sheet-note">模式同时决定权限与思考等级，并可能注入行为指令（如迭代/调研）。</p>
                {view.availableModes.length === 0 ? (
                  <p className="sheet-note">主机未上报可选模式列表。</p>
                ) : (
                  <div className="sheet-list">
                    <button
                      type="button"
                      className={`sheet-item ${view.taskMode ? "" : "on"}`}
                      disabled={modelBusy}
                      onClick={() => void chooseMode("")}
                    >
                      <span className="sheet-item-main">
                        基线
                        <em className="sheet-tag">不注入</em>
                      </span>
                      {view.taskMode ? null : <IconCheck />}
                    </button>
                    {view.availableModes.map((option) => {
                      const active = view.taskMode === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className={`sheet-item ${active ? "on" : ""}`}
                          disabled={modelBusy}
                          onClick={() => void chooseMode(option.id)}
                        >
                          <span className="sheet-item-main">
                            {option.name}
                            {option.summary && <em className="sheet-tag">{option.summary}</em>}
                          </span>
                          {active && <IconCheck />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : sheet === "permission" ? (
              <>
                <div className="sheet-title">权限级别</div>
                <p className="sheet-note">沙盒：写文件/执行命令前需要你批准；完整：不再逐条询问。</p>
                <button
                  type="button"
                  className={`sheet-item ${view.summary?.permission === "sandbox" ? "on" : ""}`}
                  onClick={() => void togglePermission()}
                >
                  <span>沙盒（逐条批准）</span>
                  {view.summary?.permission === "sandbox" && <IconCheck />}
                </button>
                <button
                  type="button"
                  className={`sheet-item ${view.summary?.permission === "full" ? "on" : ""}`}
                  onClick={() => void togglePermission()}
                >
                  <span>完整权限（不询问）</span>
                  {view.summary?.permission === "full" && <IconCheck />}
                </button>
              </>
            ) : (
              <>
                <div className="sheet-title">选择模型</div>                {view.availableModels.length === 0 ? (
                  <p className="sheet-note">主机未上报可选模型列表。</p>
                ) : (
                  <div className="sheet-list">
                    {view.availableModels.map((option) => {
                      const active = view.model?.provider === option.provider && view.model?.id === option.id;
                      return (
                        <button
                          key={`${option.provider}/${option.id}`}
                          type="button"
                          className={`sheet-item ${active ? "on" : ""}`}
                          disabled={modelBusy}
                          onClick={() => void chooseModel(option.provider, option.id)}
                        >
                          <span className="sheet-item-main">
                            {option.name || option.id}
                            {option.reasoning && <em className="sheet-tag">思考</em>}
                          </span>
                          {active && <IconCheck />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {/* S6.3 approval card (full-screen, above everything) */}
      {view.pendingUi && <ApprovalCard request={view.pendingUi} busy={uiBusy} error={uiError} onRespond={onRespondUi} />}
    </div>
  );
}
