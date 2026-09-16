import { useEffect, useMemo, useRef, useState } from "react";
import { draftKeyFor, useStore } from "../store";
import { formatTokens, modelShort } from "../lib/format";
import { reasoningLevelLabel } from "../lib/reasoning";
import { BUILTIN_BALANCED_ID, normalizeTaskModes, taskModeName, taskModeSummary } from "../lib/task-modes";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { ComposerDraft, HtmlElementReference, ModelInfo, PermissionLevel, PendingFile, PendingImage, TaskModeDef } from "../lib/types";
import { MPI_FILE_MIME, MPI_SESSION_MIME, parseSessionDragPayload } from "../lib/file-drag";
import { SttError, startRecording, sttRecordErrorText, sttTranscribeErrorText, type RecordingHandle } from "../lib/stt";
import { Plus, Send, Stop, Shield, Edit, Zap, Folder, Search, Check, ChevronRight, Bell, Compress, Refresh, Settings, Mic, Info } from "./icons";
import { LongTaskMonitor } from "./LongTaskMonitor";
import { TaskModesModal } from "./TaskModesModal";
import { TaskModeDetailModal } from "./TaskModeDetailModal";

let _pid = 0;
const pid = () => `p${_pid++}`;
/** Stable empties so a draft-less thread does not allocate per render. */
const EMPTY_DRAFT: ComposerDraft = { text: "", images: [], files: [], htmlReferences: [] };
const EMPTY_REFS: HtmlElementReference[] = [];
/** Ring geometry for the context-usage button (SVG viewBox 20×20). */
const RING_R = 7.5;
const RING_C = 2 * Math.PI * RING_R;
const MAX_PASTED_FILE_BYTES = 50_000_000;
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

function fileExtension(name: string): string {
  const match = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] || "";
}

function imageMimeType(file: File): string {
  if (file.type.toLowerCase().startsWith("image/")) return file.type;
  return IMAGE_MIME_BY_EXT[fileExtension(file.name)] || "";
}

function fileToImage(file: File): Promise<PendingImage | null> {
  return new Promise((resolve) => {
    const mimeType = imageMimeType(file);
    if (!mimeType) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.split(",")[1] || "";
      resolve(base64 ? { id: pid(), dataUrl, base64, mimeType } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    for (const byte of chunk) binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function fileToAttachment(file: File): Promise<{ image?: PendingImage; file?: PendingFile } | null> {
  if (file.size > MAX_PASTED_FILE_BYTES) throw new Error("文件超过 50 MB，无法粘贴");
  const image = await fileToImage(file);
  if (image) return { image };

  let abs = "";
  try {
    abs = window.pi.app.getPathForFile(file) || (file as File & { path?: string }).path || "";
  } catch {
    // Clipboard-created files are not backed by a path; they are staged below.
  }
  if (abs) return { file: { abs, name: file.name || abs.split(/[\\/]/).pop() || "pasted-file" } };

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) return null;
  const staged = await window.pi.app.stageClipboardFile({
    name: file.name || "pasted-file",
    mimeType: file.type,
    data: bytesToBase64(bytes),
  });
  return staged?.abs ? { file: { abs: staged.abs, name: staged.name || file.name || "pasted-file" } } : null;
}

function promptTextWithHtmlReferences(text: string, references: HtmlElementReference[]): string {
  const prompt = text.trim();
  const selectedElements = references
    .map((reference) => reference.reference.trim())
    .filter(Boolean)
    .join("\n\n");
  return prompt ? (selectedElements ? `${prompt}\n\n${selectedElements}` : prompt) : selectedElements;
}

export function Composer({ threadId }: { threadId: string }) {
  // Select only what the composer renders, as primitives / stable references.
  // Subscribing to the whole thread object made every streaming token
  // re-render the entire composer (textarea included).
  const isStreaming = useStore((s) => !!s.threads[threadId]?.isStreaming);
  const pending = useStore((s) => s.threads[threadId]?.pendingFollowUp || null);
  const injected = useStore((s) => s.threads[threadId]?.pendingEditorText);
  const permission = useStore((s) => s.threads[threadId]?.permission);
  // Task-mode preset (pill left of the permission one): raw config refs so
  // zustand sees stable values; normalized via useMemo below.
  const taskMode = useStore((s) => s.threads[threadId]?.taskMode);
  const taskModesRaw = useStore((s) => s.config?.taskModes);
  const defaultTaskModeId = useStore((s) => s.config?.defaultTaskModeId);
  const applyTaskMode = useStore((s) => s.applyTaskMode);
  const language = useStore((s) => s.config?.language || "en");
  const commands = useStore((s) => s.threads[threadId]?.commands);
  const models = useStore((s) => s.threads[threadId]?.models);
  const levels = useStore((s) => s.threads[threadId]?.levels);
  const model = useStore((s) => s.threads[threadId]?.model);
  // P1-12 auto mode: pill dot + dropdown Auto item.
  const autoEnabled = !!useStore((s) => s.threads[threadId]?.autoEnabled);
  const autoStatus = useStore((s) => s.threads[threadId]?.autoStatus ?? null);
  const setAutoModel = useStore((s) => s.setAutoModel);
  const thinking = useStore((s) => s.threads[threadId]?.thinking);
  const cwd = useStore((s) => s.threads[threadId]?.cwd || "");
  const sessionFile = useStore((s) => s.threads[threadId]?.sessionFile || null);
  // Post-compaction token estimate (pi reports tokens=null until the next reply).
  const contextEstimate = useStore((s) => s.threads[threadId]?.contextEstimate);
  const isDraftTask = useStore(
    (s) => !s.threads[threadId]?.messages.some((message) => message.role === "user" || message.role === "assistant"),
  );
  const projects = useStore((s) => s.projects);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const abortThread = useStore((s) => s.abortThread);
  const setModel = useStore((s) => s.setModel);
  const setThinking = useStore((s) => s.setThinking);
  const setPermission = useStore((s) => s.setPermission);
  const setPendingFollowUp = useStore((s) => s.setPendingFollowUp);
  const sendPendingSteering = useStore((s) => s.sendPendingSteering);
  const changeDraftThreadFolder = useStore((s) => s.changeDraftThreadFolder);
  const pushToast = useStore((s) => s.pushToast);
  const openSettings = useStore((s) => s.openSettings);
  const compacting = useStore((s) => !!s.threads[threadId]?.compacting);
  const connected = useStore((s) => !!s.threads[threadId]?.connected);
  const hasMessages = useStore(
    (s) => (s.threads[threadId]?.messages || []).some((message) => message.role === "user" || message.role === "assistant"),
  );
  const soundOnComplete = useStore((s) => s.config?.soundOnComplete !== false);
  const compactContext = useStore((s) => s.compactContext);
  const setSoundOnComplete = useStore((s) => s.setSoundOnComplete);

  // Unsent content lives in the store keyed per thread (see draftKeyFor) so it
  // survives app restarts and swaps correctly when switching threads; main
  // persists it with LRU eviction. expandedHtmlReferences stays local — pure UI.
  // Sanitized task-mode list (built-ins re-seeded with localized defaults;
  // corrupt config safe).
  const taskModes = useMemo(() => normalizeTaskModes(taskModesRaw, language), [taskModesRaw, language]);
  // No explicit choice yet → the everyday default “balanced” mode.
  const activeTaskModeId = taskMode ?? defaultTaskModeId ?? BUILTIN_BALANCED_ID;
  const activeTaskMode = taskModes.find((m) => m.id === activeTaskModeId) || taskModes[0];

  const draftKey = useMemo(() => draftKeyFor({ sessionFile, cwd }, threadId), [sessionFile, cwd, threadId]);
  const draft = useStore((s) => (draftKey ? s.drafts[draftKey] : undefined));
  const setDraft = useStore((s) => s.setDraft);
  const clearDraft = useStore((s) => s.clearDraft);
  const text = draft?.text ?? EMPTY_DRAFT.text;
  const images = draft?.images ?? EMPTY_DRAFT.images;
  const files = draft?.files ?? EMPTY_DRAFT.files;
  const htmlReferences = draft?.htmlReferences ?? EMPTY_REFS;

  /** Merge a partial update into this thread's current draft (fresh read, so
   * rapid updates never clobber each other). */
  const patchDraft = (patch: Partial<ComposerDraft>) => {
    if (!draftKey) return;
    const current = useStore.getState().drafts[draftKey];
    setDraft(draftKey, { ...EMPTY_DRAFT, ...current, ...patch });
  };
  const [expandedHtmlReferences, setExpandedHtmlReferences] = useState<Record<string, boolean>>({});
  const [modelOpen, setModelOpen] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const [cmdOpen, setCmdOpen] = useState(false);
  // Thinking-level options expanded inside the model popover.
  const [thinkOpen, setThinkOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [permOpen, setPermOpen] = useState(false);
  // Task-mode dropdown + management modal.
  const [tmOpen, setTmOpen] = useState(false);
  const [tmManageOpen, setTmManageOpen] = useState(false);
  const [tmDetail, setTmDetail] = useState<TaskModeDef | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  // Voice input (STT): idle → recording → transcribing. The handle lives in a
  // ref; the draft key is captured at start so a thread switch mid-recording
  // still lands the transcript in the thread where it was spoken.
  const [recState, setRecState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [recSeconds, setRecSeconds] = useState(0);
  const recHandleRef = useRef<RecordingHandle | null>(null);
  const recTimerRef = useRef<number | null>(null);
  const recDraftKeyRef = useRef<string>("");
  // Highlight while a file is dragged over the composer (sidebar file tree or OS
  // files). A depth counter avoids flicker when moving across child elements.
  const [fileDragOver, setFileDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const tmRef = useRef<HTMLDivElement>(null);
  const permRef = useRef<HTMLDivElement>(null);
  const cmdRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef<HTMLDivElement>(null);

  // close popups on outside click / Escape
  useOutsideClose(tmRef, tmOpen, () => setTmOpen(false));
  useOutsideClose(permRef, permOpen, () => setPermOpen(false));
  useOutsideClose(cmdRef, cmdOpen, () => setCmdOpen(false));
  useOutsideClose(modelRef, modelOpen, () => setModelOpen(false));
  useOutsideClose(projectRef, projectOpen, () => setProjectOpen(false));

  // Collapse the thinking-level options whenever the model popover closes.
  useEffect(() => {
    if (!modelOpen) setThinkOpen(false);
  }, [modelOpen]);

  // Context-usage ring + popover (bottom bar, before the model pill).
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxStats, setCtxStats] = useState<any>(null);
  const [ctxComps, setCtxComps] = useState<{ count: number; lastAt: string | null } | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  useOutsideClose(ctxRef, ctxOpen, () => setCtxOpen(false));

  // Compaction count is read straight from the session JSONL (no live bridge
  // needed), so it stays accurate across restarts and for disconnected threads.
  const loadCompactions = async () => {
    if (!sessionFile) {
      setCtxComps(null);
      return;
    }
    try {
      const stats = await window.pi.thread.getCompactionStats(sessionFile);
      // Guard: the composer instance survives thread switches, so a stale
      // in-flight read must not overwrite the new thread's data.
      if (useStore.getState().activeThreadId === threadId) setCtxComps(stats);
    } catch {
      if (useStore.getState().activeThreadId === threadId) setCtxComps(null);
    }
  };

  const loadCtx = async () => {
    setCtxLoading(true);
    void loadCompactions();
    try {
      const id = await useStore.getState().ensureConnected(threadId);
      if (useStore.getState().activeThreadId !== threadId) return; // switched away mid-flight
      setCtxStats(id ? await window.pi.thread.getStats(id) : null);
    } catch {
      if (useStore.getState().activeThreadId === threadId) setCtxStats(null);
    }
    if (useStore.getState().activeThreadId === threadId) setCtxLoading(false);
  };

  // The ring is always visible, so keep it fresh: load on thread switch,
  // refresh when streaming/compaction ends (new usage lands then), and poll
  // while a run is in flight so the arc grows live.
  useEffect(() => {
    setCtxStats(null);
    setCtxComps(null);
    void loadCtx();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) void loadCtx();
    prevStreamingRef.current = isStreaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  const prevCompactingRef = useRef(compacting);
  useEffect(() => {
    if (prevCompactingRef.current && !compacting) void loadCtx();
    prevCompactingRef.current = compacting;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compacting]);

  // P1-12: a model change (auto-switch or manual) may mean a different context
  // window — refresh the gauge so the arc doesn't show stale percentages.
  const ctxModelKey = `${model?.provider ?? ""}\u0000${model?.id ?? ""}`;
  useEffect(() => {
    void loadCtx();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxModelKey]);

  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(loadCtx, 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  const ctxUsage = ctxStats?.contextUsage;
  // After compaction pi reports tokens=null until the next LLM response; fall back to the post-compaction estimate.
  const ctxIsEstimate = !!ctxUsage && typeof ctxUsage.tokens !== "number";
  const ctxUsed = !ctxUsage ? 0 : (typeof ctxUsage.tokens === "number" ? ctxUsage.tokens : contextEstimate ?? 0);
  const ctxHasValue = !ctxUsage || (!ctxIsEstimate || typeof contextEstimate === "number");
  const ctxTotal = ctxUsage?.contextWindow ?? 0;
  const ctxPctRaw = ctxUsage ? (typeof ctxUsage.percent === "number" ? ctxUsage.percent : ctxTotal ? (ctxUsed / ctxTotal) * 100 : 0) : 0;
  // pi reports percent as a raw float — display at most two decimals.
  const ctxPct = Math.round(ctxPctRaw * 100) / 100;
  // Threshold bands for "should I compact?": ≤60% green, 60–74% yellow,
  // 75–89% orange, ≥90% red.
  const ctxBand = ctxPct >= 90 ? "hi" : ctxPct >= 75 ? "mid" : ctxPct >= 60 ? "warn" : "low";
  // Ring arc percent (empty track until the first stats arrive).
  const ringPct = ctxHasValue && ctxTotal > 0 ? Math.min(100, ctxPct) : 0;

  // Compaction advice: usage-band guidance plus a note once repeated
  // compactions start eroding early-session detail.
  const ctxAdvice = (() => {
    if (!ctxUsage) return null;
    let base: string;
    switch (ctxBand) {
      case "hi":
        base = language === "zh" ? "占用过高，建议立即手动压缩（自动压缩也可能随时触发）" : "Very high — compact now (auto-compaction may trigger at any time)";
        break;
      case "mid":
        base = language === "zh" ? "占用偏高，建议手动压缩为后续回复留出空间" : "Running high — consider compacting to leave headroom for upcoming replies";
        break;
      case "warn":
        base = language === "zh" ? "接近警戒线，长任务可提前手动压缩" : "Approaching the warning zone — on long tasks, compact early";
        break;
      default:
        base = language === "zh" ? "占用较低，暂无需压缩" : "Usage is low — no compaction needed yet";
    }
    const n = ctxComps?.count ?? 0;
    if (n >= 3) {
      base +=
        language === "zh"
          ? `；本会话已压缩 ${n} 次，早期细节可能丢失，重要结论建议写入文件或记忆`
          : `; compacted ${n}× this session — early details may be lost, write key conclusions to files or memory`;
    }
    return base;
  })();
  const ctxCompLast = ctxComps?.lastAt ? new Date(ctxComps.lastAt).toLocaleString() : null;

  // extension-injected editor text
  const lastInjected = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (injected && injected !== lastInjected.current) {
      lastInjected.current = injected;
      patchDraft({ text: injected });
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [injected]);

  // HTML preview annotation mode sends a structured element reference here.
  // Keep the full context attached to the draft while rendering it as a
  // collapsible card instead of exposing raw selector/HTML in the textarea.
  useEffect(() => {
    const onElementReference = (event: Event) => {
      const detail = (event as CustomEvent<{
        threadId?: string;
        reference?: string;
        element?: {
          selector?: string;
          tagName?: string;
          text?: string;
          outerHTML?: string;
          styles?: Record<string, string | number>;
        };
      }>).detail;
      const reference = detail?.reference?.trim();
      if (!reference || detail?.threadId !== threadId) return;
      const element = detail.element || {};
      const selected: HtmlElementReference = {
        id: pid(),
        reference,
        selector: String(element.selector || "").trim(),
        tagName: String(element.tagName || "").trim().toLowerCase(),
        text: String(element.text || "").trim(),
        outerHTML: String(element.outerHTML || "").trim(),
        styles: element.styles,
      };
      // A new selection replaces the previous target. The composer should
      // always describe the element the user most recently picked, rather
      // than accumulating stale HTML references in the draft.
      patchDraft({ htmlReferences: [selected] });
      setExpandedHtmlReferences({});
      requestAnimationFrame(() => taRef.current?.focus());
    };
    window.addEventListener("mpi-html-element-reference", onElementReference);
    return () => window.removeEventListener("mpi-html-element-reference", onElementReference);
  }, [threadId, draftKey]);

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  };
  useEffect(autoGrow, [text]);

  const addAttachments = async (sourceFiles: File[]) => {
    const imgs: PendingImage[] = [];
    const fs: PendingFile[] = [];
    for (const f of sourceFiles) {
      try {
        const attachment = await fileToAttachment(f);
        if (attachment?.image) imgs.push(attachment.image);
        if (attachment?.file) fs.push(attachment.file);
      } catch (error: any) {
        const name = f.name || (language === "zh" ? "文件" : "file");
        const reason = error?.message || (language === "zh" ? "无法读取" : "could not be read");
        pushToast("warning", language === "zh" ? `${name} 添加失败：${reason}` : `${name} could not be added: ${reason}`);
      }
    }
    patchDraft({
      images: [...images, ...imgs],
      files: (() => {
        const existing = new Set(files.map((file) => file.abs));
        return [...files, ...fs.filter((file) => !existing.has(file.abs))];
      })(),
    });
  };

  /** True when the drag payload is a file, a session reference (sidebar
   * thread row), or OS files. */
  const isFileDrag = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types || []);
    return types.includes(MPI_FILE_MIME) || types.includes(MPI_SESSION_MIME) || types.includes("Files");
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setFileDragOver(false);
    // In-app drags carry payloads, not File objects. A session reference
    // (dragged from a sidebar thread row) becomes an attachment whose .jsonl
    // path the agent reads with its file tools.
    const sessionPayload = parseSessionDragPayload(e.dataTransfer.getData(MPI_SESSION_MIME));
    if (sessionPayload) {
      patchDraft({ files: [...files, ...(!files.some((f) => f.abs === sessionPayload.file) ? [{ abs: sessionPayload.file, name: sessionPayload.title }] : [])] });
      return;
    }
    // In-app drag from the sidebar file tree carries a path, not a File object.
    const internalPath = e.dataTransfer.getData(MPI_FILE_MIME);
    if (internalPath) {
      const name = internalPath.split(/[\\/]/).pop() || internalPath;
      patchDraft({ files: [...files, ...(!files.some((f) => f.abs === internalPath) ? [{ abs: internalPath, name }] : [])] });
      return;
    }
    const dropped = Array.from(e.dataTransfer.files || []);
    if (!dropped.length) return;
    await addAttachments(dropped);
  };

  const addFiles = async () => {
    const paths = await window.pi.app.showOpenDialog("files");
    if (!paths || !Array.isArray(paths)) return;
    const names = paths.map((p) => p.split(/[\\/]/).pop() || p);
    patchDraft({ files: [...files, ...paths.map((abs, i) => ({ abs, name: names[i] }))] });
  };

  /* ---------------- Voice input (STT) ---------------- */
  // ~3 min ≈ 5.8 MB of 16 kHz mono WAV — comfortably inside API and IPC limits.
  const MAX_REC_SECONDS = 180;
  const formatRecSeconds = (total: number) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;

  const stopRecTimer = () => {
    if (recTimerRef.current !== null) {
      window.clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
  };

  /** Discard the recording (Esc / unmount). */
  const cancelRecording = () => {
    const handle = recHandleRef.current;
    recHandleRef.current = null;
    stopRecTimer();
    setRecSeconds(0);
    setRecState("idle");
    try {
      handle?.cancel();
    } catch {
      // already stopped
    }
  };

  /** Stop the mic, transcribe, and append the text to the captured draft. */
  const finishRecording = async () => {
    const handle = recHandleRef.current;
    if (!handle) return;
    recHandleRef.current = null;
    stopRecTimer();
    setRecState("transcribing");
    try {
      const audio = await handle.stop();
      const res = await window.pi.voice.transcribe({ dataBase64: audio.base64 });
      if (!res.ok) {
        pushToast("error", sttTranscribeErrorText(res.error || "", language === "zh"));
        return;
      }
      const transcript = (res.text || "").trim();
      // Append into the draft of the thread where recording STARTED — this
      // composer instance survives thread switches, so trust the captured key.
      const key = recDraftKeyRef.current;
      if (!key) return;
      const current = useStore.getState().drafts[key];
      const base = (current?.text || "").trimEnd();
      setDraft(key, { ...EMPTY_DRAFT, ...current, text: transcript ? `${base ? `${base} ` : ""}${transcript}` : (current?.text ?? "") });
      if (!transcript) {
        pushToast("info", language === "zh" ? "未识别到语音内容" : "No speech recognized");
      } else if (useStore.getState().activeThreadId === threadId) {
        requestAnimationFrame(() => taRef.current?.focus());
      }
    } catch (e: any) {
      pushToast(
        "error",
        e instanceof SttError
          ? sttRecordErrorText(e.code, language === "zh")
          : language === "zh"
            ? `语音识别失败：${e?.message || e}`
            : `Transcription failed: ${e?.message || e}`,
      );
    } finally {
      setRecSeconds(0);
      setRecState("idle");
    }
  };

  const startVoiceInput = async () => {
    // Dev instances started before this feature shipped lack window.pi.voice.
    if (typeof window.pi?.voice !== "object" || !window.pi.voice) {
      pushToast("warning", language === "zh" ? "当前版本不支持语音系统，请完整重启应用" : "This build predates the voice system — fully restart the app");
      return;
    }
    if (!useStore.getState().config?.voice?.sttBackend) {
      pushToast(
        "warning",
        language === "zh"
          ? "语音输入未配置：请先在 设置 → 对话设置 → 语音系统 中选择识别服务"
          : "Voice input is not configured: pick a transcription service in Settings → Conversation → Voice",
      );
      openSettings();
      return;
    }
    try {
      const handle = await startRecording();
      recHandleRef.current = handle;
      recDraftKeyRef.current = draftKey || "";
      setRecSeconds(0);
      setRecState("recording");
      let elapsed = 0;
      recTimerRef.current = window.setInterval(() => {
        elapsed += 1;
        setRecSeconds(elapsed);
        if (elapsed >= MAX_REC_SECONDS) void finishRecording(); // auto-stop at the cap
      }, 1000);
    } catch (e: any) {
      pushToast(
        "error",
        e instanceof SttError ? sttRecordErrorText(e.code, language === "zh") : language === "zh" ? "无法启动录音" : "Could not start recording",
      );
    }
  };

  const toggleVoiceInput = () => {
    if (recState === "idle") void startVoiceInput();
    else if (recState === "recording") void finishRecording();
  };

  // Esc cancels an in-flight recording; unmount releases the microphone.
  useEffect(() => {
    if (recState !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRecording();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recState]);
  useEffect(() => {
    return () => {
      recHandleRef.current?.cancel();
      stopRecTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    const itemFiles = items
      ? Array.from(items)
        .filter((item) => item.kind === "file" || item.type.toLowerCase().startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file)
      : [];
    const files = itemFiles.length ? itemFiles : Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    await addAttachments(files);
  };

  const send = async (mode?: "steer" | "followUp") => {
    const t = promptTextWithHtmlReferences(text, htmlReferences);
    if (!t && !images.length && !files.length) return;
    const imgs = images.map((im) => ({ data: im.base64, mimeType: im.mimeType }));
    const atts = files.map((f) => ({ abs: f.abs, name: f.name }));
    clearDraft(draftKey || "");
    setExpandedHtmlReferences({});
    await sendPrompt(threadId, t, imgs.length ? imgs : undefined, atts.length ? atts : undefined, mode);
  };

  // While streaming, Enter stages the message as a pending follow-up card
  // instead of sending it. It is delivered when the agent settles, unless the
  // user re-edits it or promotes it to steering first.
  const queuePending = () => {
    const t = text.trim();
    if (!t && !htmlReferences.length && !images.length && !files.length) return;
    if (pending) {
      // A follow-up is already staged; queue this one straight into pi.
      const imgs = images.map((im) => ({ data: im.base64, mimeType: im.mimeType }));
      const atts = files.map((f) => ({ abs: f.abs, name: f.name }));
      const prompt = promptTextWithHtmlReferences(text, htmlReferences);
      clearDraft(draftKey || "");
      setExpandedHtmlReferences({});
      sendPrompt(threadId, prompt, imgs.length ? imgs : undefined, atts.length ? atts : undefined, "followUp");
      return;
    }
    setPendingFollowUp(threadId, {
      text: t,
      images,
      files,
      htmlReferences: htmlReferences.length ? htmlReferences : undefined,
    });
    clearDraft(draftKey || "");
    setExpandedHtmlReferences({});
  };

  const reEditPending = () => {
    if (!pending) return;
    if (draftKey) {
      setDraft(draftKey, {
        text: pending.text,
        images: pending.images,
        files: pending.files,
        htmlReferences: pending.htmlReferences || [],
      });
    }
    setExpandedHtmlReferences({});
    setPendingFollowUp(threadId, null);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      autoGrow();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // While an IME composition is in progress the input method owns every key
    // (Enter confirms a candidate, arrows navigate it). Never treat those as
    // submit / slash-menu navigation — otherwise Chinese/Japanese typing would
    // send the draft or accept a command mid-word.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (slashMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((index) => (index + 1) % slashItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((index) => (index - 1 + slashItems.length) % slashItems.length);
        return;
      }
      // Shift+Enter must still insert a newline even with the menu open; the
      // inserted line break ends the trailing "/token" so the menu closes on its own.
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && slashItems.length > 0) {
        e.preventDefault();
        chooseSlashCommand(slashItems[slashIndex] || slashItems[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (compacting) {
        // pi hard-rejects prompts while compaction is in flight; say so instead.
        pushToast("info", language === "zh" ? "压缩进行中，请稍候再发送" : "Compaction in progress — please wait");
        return;
      }
      if (isStreaming) {
        // Alt+Enter interrupts now (steering); Enter stages a pending follow-up.
        if (e.altKey) send("steer");
        else queuePending();
      } else {
        send();
      }
    }
  };

  const modelList = models || [];
  const modelGroups = useMemo(() => {
    const grouped = new Map<string, ModelInfo[]>();
    for (const item of modelList) {
      const providerModels = grouped.get(item.provider) || [];
      providerModels.push(item);
      grouped.set(item.provider, providerModels);
    }
    return Array.from(grouped, ([provider, providerModels]) => ({ provider, models: providerModels }));
  }, [modelList]);
  const levelList = (levels || []).filter((l) => l !== "off");
  const thinkLabel = thinking === "off" ? "" : reasoningLevelLabel(thinking, language);
  const mappedThinkingLevel = (level: string) => {
    const mapped = model?.thinkingLevelMap?.[level];
    return mapped && mapped !== level ? mapped : null;
  };
  const projectName = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd || (language === "zh" ? "暂无项目" : "No project");
  const visibleProjects = projects.filter((project) => {
    const query = projectQuery.trim().toLowerCase();
    return !query || project.name.toLowerCase().includes(query) || project.cwd.toLowerCase().includes(query);
  });
  // A slash command may be typed after an existing prompt. Only inspect the
  // final whitespace-delimited token so ordinary text (and paths/URLs) does
  // not open the menu prematurely.
  const slashMatch = text.match(/(?:^|\s)\/([^\s]*)$/);
  const slashQuery = (slashMatch?.[1] || "").toLowerCase();
  // /compact is a built-in TUI command that RPC mode cannot run via prompt;
  // MPI routes it to the dedicated compact call, so advertise it in the menus.
  const builtinCommands = useMemo(
    () => [
      {
        name: "compact",
        description: language === "zh" ? "压缩上下文（等同模型面板中的按钮）" : "Compact context (same as the button in the model panel)",
        source: "builtin",
      },
    ],
    [language],
  );

  const slashItems = useMemo(() => {
    const all = [...builtinCommands, ...((commands || []).filter((command: any) => command.name !== "compact"))];
    return (
      all
        .filter((command: any) => {
          const displayName = command.source === "skill" ? String(command.name).replace(/^skill:/, "") : String(command.name);
          return (
            !slashQuery ||
            displayName.toLowerCase().includes(slashQuery) ||
            (command.source !== "skill" && String(command.description || "").toLowerCase().includes(slashQuery))
          );
        })
        .slice(0, 30)
    );
  }, [commands, slashQuery, builtinCommands]);
  const commandItems = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    // The command popup is already scrollable; keep the complete collection
    // so commands that appear later in the list remain reachable without a search.
    const all = [...builtinCommands, ...((commands || []).filter((command: any) => command.name !== "compact"))];
    return all.filter((command: any) => {
      const rawName = String(command.name || "");
      const displayName = command.source === "skill" ? rawName.replace(/^skill:/, "") : rawName;
      const haystack = [rawName, displayName, String(command.description || ""), String(command.source || "")]
        .join(" ")
        .toLowerCase();
      return !query || haystack.includes(query);
    });
  }, [commands, commandQuery, builtinCommands]);
  const slashMenuOpen = !!slashMatch && !slashDismissed && slashItems.length > 0;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  const chooseSlashCommand = (command: any) => {
    // Replace only the current slash token and keep any prompt text before it.
    patchDraft({ text: text.replace(/\/[^\s]*$/, `/${command.name} `) });
    setSlashDismissed(true);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const toggleCommands = () => {
    setCmdOpen((open) => {
      if (open) setCommandQuery("");
      return !open;
    });
  };

  const chooseProject = async (nextCwd: string) => {
    setProjectOpen(false);
    setProjectQuery("");
    await changeDraftThreadFolder(threadId, nextCwd);
  };

  const chooseNewProject = async () => {
    const path = await window.pi.app.showOpenDialog("folder");
    if (!path || Array.isArray(path)) return;
    await chooseProject(path);
  };

  const toggleHtmlReference = (id: string) => {
    setExpandedHtmlReferences((current) => ({ ...current, [id]: !current[id] }));
  };

  const removeHtmlReference = (id: string) => {
    patchDraft({ htmlReferences: htmlReferences.filter((reference) => reference.id !== id) });
    setExpandedHtmlReferences((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  return (
    <div
      className={`composer-wrap ${fileDragOver ? "drop-target" : ""}`}
      onDrop={onDrop}
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        dragDepthRef.current += 1;
        setFileDragOver(true);
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setFileDragOver(false);
      }}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="composer">
        {isDraftTask && !isStreaming && (
          <div className="composer-project-row" ref={projectRef}>
            <button
              className={`composer-project-pill ${projectOpen ? "open" : ""}`}
              onClick={() => setProjectOpen((value) => !value)}
              title={cwd}
              aria-haspopup="menu"
              aria-expanded={projectOpen}
            >
              <Folder size={14} />
              <span>{projectName}</span>
              <ChevronRight className="project-pill-caret" size={12} />
            </button>
            {projectOpen && (
              <div className="composer-project-menu" role="menu">
                <label className="project-menu-search">
                  <Search size={15} />
                  <input
                    autoFocus
                    value={projectQuery}
                    onChange={(event) => setProjectQuery(event.target.value)}
                    placeholder="搜索项目"
                  />
                </label>
                <div className="project-menu-list">
                  {visibleProjects.map((project) => {
                    const active = project.cwd.toLowerCase() === cwd.toLowerCase();
                    return (
                      <button
                        key={project.cwd}
                        className={`project-menu-option ${active ? "active" : ""}`}
                        onClick={() => chooseProject(project.cwd)}
                        role="menuitemradio"
                        aria-checked={active}
                        title={project.cwd}
                      >
                        <Folder size={16} />
                        <span>{project.name}</span>
                        {active && <Check className="project-menu-check" size={16} />}
                      </button>
                    );
                  })}
                  {visibleProjects.length === 0 && <div className="project-menu-empty">没有匹配的项目</div>}
                </div>
                <div className="project-menu-divider" />
                <button className="project-menu-new" onClick={chooseNewProject}>
                  <Plus size={16} />
                  <span>新建项目</span>
                </button>
              </div>
            )}
          </div>
        )}
        {slashMenuOpen && (
          <div className="slash-menu" role="listbox" aria-label={language === "zh" ? "斜杠命令" : "Slash commands"}>
            <div className="slash-menu-head">{language === "zh" ? "命令、扩展功能和技能" : "Commands, extensions & skills"}</div>
            <div className="slash-menu-list">
              {slashItems.map((command: any, index: number) => {
                const isSkill = command.source === "skill";
                const displayName = isSkill ? String(command.name).replace(/^skill:/, "") : command.name;
                const kind = language === "zh"
                  ? isSkill
                    ? "技能"
                    : command.source === "extension"
                      ? "扩展功能"
                      : "提示词"
                  : isSkill
                    ? "Skill"
                    : command.source === "extension"
                      ? "Extension"
                      : "Prompt";
                return (
                  <button
                    key={`${command.source || "command"}:${command.name}`}
                    className={`slash-menu-item ${index === slashIndex ? "active" : ""}`}
                    role="option"
                    aria-selected={index === slashIndex}
                    onMouseEnter={() => setSlashIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSlashCommand(command)}
                  >
                    <span className="slash-command-name">{displayName}</span>
                    <span className={`slash-command-kind ${command.source || "command"}`}>{kind}</span>
                    {!isSkill && command.description && (
                      <span className="slash-command-description">{command.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {(images.length > 0 || files.length > 0) && (
          <div className="composer-attachments">
            {images.map((im) => (
              <div key={im.id} className="attach-chip">
                <img src={im.dataUrl} alt="" />
                <span className="nm">{language === "zh" ? "图像" : "image"}</span>
                <button className="rm" onClick={() => patchDraft({ images: images.filter((x) => x.id !== im.id) })}>
                  ×
                </button>
              </div>
            ))}
            {files.map((f) => (
              <div key={f.abs} className="attach-chip">
                {/* .jsonl = a dragged session reference (sidebar thread row). */}
                <span>{f.abs.toLowerCase().endsWith(".jsonl") ? "💬" : "📎"}</span>
                <span className="nm" title={f.abs}>
                  {f.name || f.abs.split(/[\\/]/).pop()}
                </span>
                <button className="rm" onClick={() => patchDraft({ files: files.filter((x) => x.abs !== f.abs) })}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {pending && (
          <div className="pending-fu">
            <div className="pf-main">
              <div className="pf-label">
                <span className="pf-dot" />
                {language === "zh" ? "待处理后续" : "Pending follow-up"}
                <span className="pf-sub">· 当前任务完成后自动发送</span>
              </div>
              <div className="pf-text">
                {pending.text || (pending.htmlReferences?.length
                  ? `${pending.htmlReferences.length} 个 HTML 元素`
                  : `${pending.images.length + pending.files.length} 个附件`)}
              </div>
            </div>
            <div className="pf-actions">
              <button className="pf-btn" title="重新编辑" onClick={reEditPending}>
                <Edit size={14} />
              </button>
              <button className="pf-btn steer" title={language === "zh" ? "立即插入上下文执行" : "Steer now (insert into context as soon as possible)"} onClick={() => sendPendingSteering(threadId)}>
                <Zap size={14} />
              </button>
            </div>
          </div>
        )}

        <div className="composer-input">
          {htmlReferences.length > 0 && (
            <div className="composer-html-references" aria-label={language === "zh" ? "已选择的 HTML 元素" : "Selected HTML elements"}>
              {htmlReferences.map((reference) => {
                const expanded = !!expandedHtmlReferences[reference.id];
                const tag = reference.tagName ? `<${reference.tagName}>` : "HTML element";
                const selector = reference.selector || tag;
                return (
                  <div key={reference.id} className={`composer-html-reference ${expanded ? "expanded" : ""}`}>
                    <div className="composer-html-reference-row">
                      <button
                        type="button"
                        className="composer-html-reference-toggle"
                        aria-expanded={expanded}
                        title={language === "zh" ? "展开或折叠元素引用" : "Expand or collapse element reference"}
                        onClick={() => toggleHtmlReference(reference.id)}
                      >
                        <ChevronRight className={`composer-html-reference-chevron ${expanded ? "open" : ""}`} size={13} />
                        <span className="composer-html-reference-badge">HTML</span>
                        <span className="composer-html-reference-tag">{tag}</span>
                        <code className="composer-html-reference-selector" title={selector}>{selector}</code>
                      </button>
                      <button
                        type="button"
                        className="composer-html-reference-remove"
                        aria-label={language === "zh" ? "移除 HTML 元素引用" : "Remove HTML element reference"}
                        title={language === "zh" ? "移除引用" : "Remove reference"}
                        onClick={() => removeHtmlReference(reference.id)}
                      >
                        ×
                      </button>
                    </div>
                    {expanded && <pre className="composer-html-reference-code">{reference.reference}</pre>}
                  </div>
                );
              })}
            </div>
          )}
          <textarea
            ref={taRef}
            rows={1}
            placeholder={isStreaming
              ? language === "zh"
                 ? "输入插话…回车存为待处理后续（完成后发送），Alt+回车立即插入，Shift+回车换行"
                : "Type a message… Enter queues a follow-up; Alt+Enter steers immediately; Shift+Enter for newline"
              : language === "zh"
                ? "随心输入  ·  Shift+回车换行  ·  粘贴图片或文件"
                : "Type a message · Shift+Enter for newline · Paste images or files"}
            value={text}
            onChange={(e) => {
              patchDraft({ text: e.target.value });
              setSlashDismissed(false);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>

        <div className="composer-bar">
          <div className="cb-left">
            <button className="iconbtn" title={language === "zh" ? "添加文件" : "Add files"} onClick={addFiles}>
              <Plus size={17} />
            </button>
            {recState === "idle" ? (
              <button
                className="iconbtn"
                title={
                  language === "zh"
                    ? "语音输入：点击开始说话，再点结束并转成文字（Esc 取消）"
                    : "Voice input: click to start speaking, click again to stop and transcribe (Esc cancels)"
                }
                onClick={() => void toggleVoiceInput()}
              >
                <Mic size={17} />
              </button>
            ) : (
              <button
                className={`iconbtn mic-recording ${recState === "transcribing" ? "busy" : ""}`}
                title={
                  recState === "recording"
                    ? language === "zh"
                      ? `正在录音（最长 3:00）——点击结束并识别，Esc 取消`
                      : `Recording (max 3:00) — click to stop and transcribe, Esc cancels`
                    : language === "zh"
                      ? "正在识别语音…"
                      : "Transcribing…"
                }
                onClick={() => recState === "recording" && void finishRecording()}
              >
                {recState === "recording" ? (
                  <>
                    <span className="mic-dot" aria-hidden="true" />
                    {formatRecSeconds(recSeconds)}
                  </>
                ) : (
                  <span className="spinner" />
                )}
              </button>
            )}
            {/* 任务模式 preset (permission + thinking level); left of the permission pill. */}
            <div className="pill taskmode-pill composer-optional-action" ref={tmRef}>
              <button
                className="pill-btn tm-btn"
                title={
                  language === "zh"
                    ? `任务模式：权限+思考等级+行为指令预设。当前「${taskModeName(activeTaskMode, language)}」（${taskModeSummary(activeTaskMode, language)}）；点击切换或管理自定义模式`
                    : `Task mode: permission + thinking + behaviour preset. Current “${taskModeName(activeTaskMode, language)}” (${taskModeSummary(activeTaskMode, language)}); click to switch or manage custom modes`
                }
                onClick={() => setTmOpen((v) => !v)}
              >
                <Zap size={13} /> {taskModeName(activeTaskMode, language)} ▾
              </button>
              {tmOpen && (
                <div className="pill-pop taskmode-pop">
                  {taskModes.map((m) => (
                    <div key={m.id} className="tm-opt-row">
                      <button
                        className={`opt ${m.id === activeTaskModeId ? "active" : ""}`}
                        onClick={() => {
                          setTmOpen(false);
                          void applyTaskMode(threadId, m.id);
                        }}
                      >
                        <span className="o1">
                          {taskModeName(m, language)}
                          {m.builtin && (
                            <small className="tm-builtin-inline">{language === "zh" ? "内置" : "Built-in"}</small>
                          )}
                        </span>
                        <span className="o2">{taskModeSummary(m, language)}</span>
                      </button>
                      <button
                        className="iconbtn tm-opt-info"
                        title={language === "zh" ? "查看说明" : "View description"}
                        onClick={() => {
                          setTmOpen(false);
                          setTmDetail(m);
                        }}
                      >
                        <Info size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="tm-manage-sep" />
                  <button
                    className="opt"
                    onClick={() => {
                      setTmOpen(false);
                      setTmManageOpen(true);
                    }}
                  >
                    <span className="o1">
                      <Settings size={12} /> {language === "zh" ? "管理任务模式…" : "Manage task modes…"}
                    </span>
                  </button>
                </div>
              )}
            </div>
            <div className="pill perm-pill composer-optional-action" ref={permRef}>
              {(() => {
                const perm = permission || "sandbox";
                const zh = language === "zh";
                const options: { level: PermissionLevel; name: string; desc: string }[] = [
                  {
                    level: "readonly",
                    name: zh ? "只读" : "Read-only",
                    desc: zh
                      ? "只读操作可执行，任何修改直接阻止（纯问答/分析）"
                      : "Read-only operations run; any mutation is blocked (pure Q&A / analysis)",
                  },
                  {
                    level: "strict",
                    name: zh ? "严格" : "Strict",
                    desc: zh
                      ? "仅只读自动执行，所有写入/删除及修改类命令均需确认"
                      : "Only read-only auto-runs; every write, deletion, or mutating command confirms",
                  },
                  {
                    level: "sandbox",
                    name: zh ? "沙盒" : "Sandbox",
                    desc: zh
                      ? "低风险明确操作自动执行，危险操作执行前需确认（默认）"
                      : "Auto-run low-risk explicit operations; confirm dangerous actions (default)",
                  },
                  {
                    level: "full",
                    name: zh ? "完全权限" : "Full access",
                    desc: zh ? "pi 默认，不拦截任何操作" : "Pi default, nothing is intercepted",
                  },
                ];
                return (
                  <>
                    <button
                      className={`pill-btn perm-btn ${perm === "full" ? "perm-full" : ""}`}
                      title={zh
                        ? "权限级别：只读=修改直接阻止；严格=仅只读自动执行；沙盒=低风险明确操作自动执行、危险操作需确认；完全权限=不拦截"
                        : "Permission level: read-only blocks mutations; strict auto-runs only read-only; sandbox auto-runs low-risk explicit operations and confirms dangerous ones; full access intercepts nothing"}
                      onClick={() => setPermOpen((v) => !v)}
                    >
                      <Shield size={13} /> {options.find((o) => o.level === perm)?.name || (zh ? "沙盒" : "Sandbox")} ▾
                    </button>
                    {permOpen && (
                      <div className="pill-pop perm-pop">
                        {options.map((option) => (
                          <button
                            key={option.level}
                            className={`opt ${perm === option.level ? "active" : ""}`}
                            onClick={() => {
                              setPermOpen(false);
                              setPermission(threadId, option.level);
                            }}
                          >
                            <span className="o1">{option.name}</span>
                            <span className="o2">{option.desc}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
            <div className="pill composer-optional-action" ref={cmdRef}>
              <button className="pill-btn" title={language === "zh" ? "斜杠命令 / 技能" : "Slash commands / skills"} onClick={toggleCommands}>
                <span className="cmd-slash">/</span> 命令
              </button>
              {cmdOpen && (
                <div className="pill-pop command-pop">
                  <label className="command-search">
                    <Search size={13} />
                    <input
                      autoFocus
                      value={commandQuery}
                      onChange={(event) => setCommandQuery(event.target.value)}
                      placeholder={language === "zh" ? "搜索命令、扩展功能或技能" : "Search commands, extensions, or skills"}
                      aria-label={language === "zh" ? "搜索命令、扩展功能或技能" : "Search commands, extensions, or skills"}
                    />
                  </label>
                  <div className="command-list">
                    {(commands || []).length === 0 && <div className="ft-empty">无可用命令</div>}
                    {(commands || []).length > 0 && commandItems.length === 0 && <div className="ft-empty">没有匹配的命令</div>}
                    {commandItems.map((c: any) => (
                      <button
                        key={`${c.source || "command"}:${c.name}`}
                        className="opt"
                        onClick={() => {
                          patchDraft({ text: (text ? text + " " : "") + `/${c.name} ` });
                          setCommandQuery("");
                          setCmdOpen(false);
                          taRef.current?.focus();
                        }}
                      >
                        <span className="o1">{c.source === "skill" ? String(c.name).replace(/^skill:/, "") : c.name}</span>
                        {c.source !== "skill" && c.description && <span className="o2">{c.description}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="cb-right">
            {/* Long-running task ring: appears next to the context ring only
                while an operation has run >10s; click for live progress. */}
            <LongTaskMonitor />
            <div className="pill ctx-ring-wrap" ref={ctxRef}>
              <button
                type="button"
                className={`ctx-ring-btn ${ctxOpen ? "on" : ""}`}
                title="当前会话上下文用量"
                aria-label="当前会话上下文用量"
                onClick={() => {
                  const next = !ctxOpen;
                  setCtxOpen(next);
                  if (next) void loadCtx();
                }}
              >
                <svg className={`ctx-ring ${ctxBand}`} width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
                  <circle className="track" cx="10" cy="10" r={RING_R} />
                  {ringPct > 0 && (
                    <circle
                      className="fill"
                      cx="10"
                      cy="10"
                      r={RING_R}
                      strokeDasharray={`${(ringPct / 100) * RING_C} ${RING_C}`}
                      transform="rotate(-90 10 10)"
                    />
                  )}
                </svg>
              </button>
              {ctxOpen && (
                <div className="ctx-pop">
                  <div className="ctx-pop-head">
                    <span>上下文窗口</span>
                    <div className="ctx-pop-actions">
                      <button className="ctx-refresh" title="刷新" onClick={() => void loadCtx()}>
                        <Refresh size={12} />
                      </button>
                    </div>
                  </div>
                  {model && <div className="ctx-model">{modelShort(model)}</div>}
                  {ctxLoading ? (
                    <div className="ctx-loading">
                      <span className="spinner" />
                    </div>
                  ) : ctxUsage ? (
                    <>
                      <div className={`ctx-bignum ${ctxBand}`}>
                        {ctxHasValue ? `${ctxIsEstimate ? "~" : ""}${formatTokens(ctxUsed)}` : "—"}
                        <span className="ctx-of"> / {formatTokens(ctxTotal)}</span>
                        {ctxUsage && ctxHasValue && (
                          <span className={`ctx-pct ${ctxBand}`} title={language === "zh" ? "上下文占用比例" : "Context usage ratio"}>
                            {ctxPct}%
                          </span>
                        )}
                      </div>
                      <div className={`ctx-bar ${ctxBand} ${ctxIsEstimate ? "est" : ""}`}>
                        <div className="ctx-bar-fill" style={{ width: `${Math.min(100, ctxHasValue ? ctxPct : 0)}%` }} />
                      </div>
                      {ctxIsEstimate && (
                        <div className="ctx-hint">压缩后估算值，下次回复后更新</div>
                      )}
                      <div className="ctx-hint">
                        {language === "zh" ? "按当前已渲染消息计算，非累计账单 tokens" : "Calculated from rendered messages, not cumulative billed tokens"}
                      </div>
                      <div className="ctx-rows">
                        <div
                          className="ctx-row"
                          title={
                            ctxCompLast
                              ? language === "zh"
                                ? `最近一次压缩：${ctxCompLast}`
                                : `Last compaction: ${ctxCompLast}`
                              : undefined
                          }
                        >
                          <span>{language === "zh" ? "已压缩" : "Compactions"}</span>
                          <span className="ctx-comp-count">
                            <b>{(ctxComps?.count ?? 0)}{language === "zh" ? " 次" : "×"}</b>
                            {/* Compact button sits right after the count it acts on. */}
                            <button
                              type="button"
                              className={`ctx-compact ${compacting ? "busy" : ""}`}
                              disabled={!connected || isStreaming || compacting || !hasMessages}
                              title={language === "zh" ? "总结较早的消息以释放上下文空间（等同 /compact）" : "Summarize earlier messages to free up context space (same as /compact)"}
                              onClick={() => void compactContext(threadId)}
                            >
                              <Compress size={12} />
                            </button>
                          </span>
                        </div>
                      </div>
                      {ctxAdvice && <div className={`ctx-advice ${ctxBand}`}>{ctxAdvice}</div>}
                    </>
                  ) : (
                    <div className="ctx-empty">暂无上下文数据</div>
                  )}
                </div>
              )}
            </div>
            <div className="pill composer-model-pill" ref={modelRef}>
              <button
                className="pill-btn"
                onClick={() => setModelOpen((v) => !v)}
                title={autoEnabled ? "模型与思考等级（auto 模式）" : "模型与思考等级"}
              >
                {autoEnabled && (
                  <span className={`model-auto-dot ${autoStatus ?? "ok"}`} title="auto 模式" />
                )}
                {modelShort(model)}
                {thinkLabel && <span className="pill-think-tag">{thinkLabel}</span>}
                <span className="pill-caret">▾</span>
              </button>
              {modelOpen && (
                <div className="pill-pop model-pop">
                  <div className="pop-head">模型</div>
                  {/* P1-12: auto mode — switch to the best available model by tier + latency. */}
                  <button
                    type="button"
                    className={`opt model-auto-row ${autoEnabled ? "active" : ""}`}
                    onClick={() => void setAutoModel(threadId, !autoEnabled)}
                  >
                    <span className="o1">
                      {language === "zh" ? "Auto（自动切换）" : "Auto (auto switch)"}
                      {autoEnabled && autoStatus && (
                        <span className={`model-auto-dot ${autoStatus}`} />
                      )}
                    </span>
                    <span className="o2">
                      {language === "zh"
                        ? autoEnabled
                          ? `当前：${modelShort(model)} · 按质量档与延迟自动切换`
                          : "按质量档与延迟在候选池间自动切换"
                        : autoEnabled
                          ? `Current: ${modelShort(model)} · switches by tier & latency`
                          : "Switches between pool models by tier & latency"}
                    </span>
                  </button>
                  {modelList.length === 0 && <div className="ft-empty">{language === "zh" ? "无可用模型（请检查认证）" : "No models available (check auth)"}</div>}
                  {modelGroups.map((group) => {
                    const expanded = expandedProviders[group.provider] === true;
                    const active = model?.provider === group.provider;
                    return (
                      <div className={`model-provider-group ${expanded ? "expanded" : ""}`} key={group.provider}>
                        <button
                          type="button"
                          className={`model-provider-toggle ${active ? "active" : ""}`}
                          onClick={() =>
                            setExpandedProviders((current) => ({
                              ...current,
                              [group.provider]: !expanded,
                            }))
                          }
                          aria-expanded={expanded}
                        >
                          <ChevronRight className="model-provider-chevron" size={13} />
                          <span className="model-provider-name">{group.provider}</span>
                          <span className="model-provider-count">{group.models.length}</span>
                        </button>
                        {expanded && (
                          <div className="model-provider-models">
                            {group.models.map((m) => (
                              <button
                                type="button"
                                key={`${m.provider}/${m.id}`}
                                className={`opt ${model?.id === m.id && model?.provider === m.provider ? "active" : ""}`}
                                onClick={() => setModel(threadId, m.provider, m.id)}
                              >
                                <span className="o1">{m.name || m.id}</span>
                                <span className="o2">{m.id}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {levelList.length > 0 && (
                    <>
                      <div className="pop-divider" />
                      <div className="think-row">
                        <span className="think-row-label">思考等级</span>
                        <button
                          type="button"
                          className={`think-pill ${thinkOpen ? "open" : ""}`}
                          onClick={() => setThinkOpen(!thinkOpen)}
                        >
                          {reasoningLevelLabel(thinking, language)}
                          <ChevronRight size={12} className={`chev ${thinkOpen ? "up" : ""}`} />
                        </button>
                      </div>
                      {thinkOpen && (
                        <div className="think-options">
                          {(["off", ...levelList] as string[]).map((l) => {
                            const mapped = mappedThinkingLevel(l);
                            return (
                              <button
                                key={l}
                                type="button"
                                className={`think-option ${thinking === l ? "active" : ""}`}
                                onClick={() => {
                                  setThinkOpen(false);
                                  setThinking(threadId, l);
                                  setModelOpen(false);
                                }}
                              >
                                <span>{reasoningLevelLabel(l, language)}</span>
                                {mapped && <span className="think-option-map">→ {mapped}</span>}
                                {thinking === l && <Check size={12} />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                  <div className="pop-divider" />
                  <div className="pop-head">{language === "zh" ? "会话工具" : "Session tools"}</div>
                  <button
                    type="button"
                    className={`opt tool-opt ${soundOnComplete ? "active" : ""}`}
                    onClick={() => void setSoundOnComplete(!soundOnComplete)}
                  >
                    <span className="o1">
                      <Bell size={13} />
                      {language === "zh" ? "完成提示音" : "Completion chime"}
                      <span className={`tool-switch ${soundOnComplete ? "on" : ""}`}>{soundOnComplete ? (language === "zh" ? "开" : "on") : language === "zh" ? "关" : "off"}</span>
                    </span>
                    <span className="o2">{language === "zh" ? "智能体完成任务时播放提示音" : "Play a short chime when the agent finishes a task"}</span>
                  </button>
                </div>
              )}
            </div>

            {isStreaming ? (
              <>
                <button
                  className="send-btn"
                  title={language === "zh" ? "存为待处理后续（回车）；Alt+回车立即插入" : "Queue as follow-up (Enter); Alt+Enter steers immediately"}
                  onClick={() => queuePending()}
                  disabled={!text.trim() && !htmlReferences.length && !images.length && !files.length}
                >
                  <Send size={15} />
                </button>
                <button className="send-btn stop" title={language === "zh" ? "停止" : "Stop"} onClick={() => abortThread(threadId)}>
                  <Stop size={16} />
                </button>
              </>
            ) : (
              <button
                className="send-btn"
                title={compacting ? (language === "zh" ? "压缩进行中…" : "Compaction in progress…") : language === "zh" ? "发送" : "Send"}
                onClick={() => send()}
                disabled={compacting || (!text.trim() && !htmlReferences.length && !images.length && !files.length)}
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      <TaskModesModal open={tmManageOpen} onClose={() => setTmManageOpen(false)} />
      {tmDetail && <TaskModeDetailModal mode={tmDetail} language={language} onClose={() => setTmDetail(null)} />}
    </div>
  );
}
