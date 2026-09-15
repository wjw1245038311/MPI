export const REMOTE_PROTOCOL_VERSION = 1 as const;

export const REMOTE_REQUEST_TYPES = [
  "projects.list",
  "threads.list",
  "thread.get",
  "thread.create",
  "thread.claimWrite",
  "thread.setPermission",
  "thread.setModel",
  "thread.setMode",
  "thread.compact",
  "thread.subscribe",
  "thread.resync",
  "thread.prompt",
  "thread.steer",
  "thread.followUp",
  "thread.abort",
  // Device-scoped (no threadId / write lease): the phone records a voice memo
  // in-browser and asks the host to transcribe it via the local STT endpoint.
  "stt.transcribe",
  "file.tree",
  "file.preview",
  "ui.respond",
] as const;

export type RemoteRequestType = (typeof REMOTE_REQUEST_TYPES)[number];

export type RemotePermission = "sandbox" | "full";

export interface RemoteImageInput {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * 手机端发送的任意文件附件（base64）。
 *
 * 与图片不同：图片作为模型的图片输入直传，文件则先由主机落盘
 * （stageClipboardFile，与桌面粘贴文件同一目录），再按桌面的
 * processAttachments 规则处理——文本类小文件内联进提示，二进制/大文件以
 * <file path=… /> 引用交给 agent 自己读。
 */
export interface RemoteFileInput {
  name: string;
  mimeType?: string;
  data: string;
}

export type RemoteEnvelope<T = unknown> = {
  v: typeof REMOTE_PROTOCOL_VERSION;
  type: string;
  requestId?: string;
  sessionId: string;
  threadId?: string;
  seq?: number;
  sentAt: number;
  payload?: T;
  error?: { code: string; message: string };
};

export interface RemoteProject {
  id: string;
  name: string;
  threadCount: number;
  updatedAt: number;
}

export type RemoteThreadState = "draft" | "idle" | "running" | "error" | "disconnected";

export interface RemoteThreadSummary {
  id: string;
  projectId: string;
  title: string;
  preview: string;
  updatedAt: number;
  messageCount: number;
  state: RemoteThreadState;
  permission: RemotePermission;
}

export interface RemoteMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text?: string;
  blocks?: Array<{
    type: "text" | "thinking" | "tool" | "image";
    text?: string;
    name?: string;
    running?: boolean;
    result?: string;
    /** Tool call arguments, compacted to one line (host-side). Phones show this
     * in the collapsed row — without it a tool row reads as a bare "✓ bash". */
    args?: string;
    data?: string;
    mimeType?: string;
  }>;
  /** Files created or updated by this assistant round. Paths are project-relative. */
  artifacts?: RemoteFileArtifact[];
  timestamp?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
}

export interface RemoteFileArtifact {
  name: string;
  path: string;
  ext: string;
  action: "created" | "updated";
}

export interface RemoteThreadSnapshot extends RemoteThreadSummary {
  cwdName: string;
  model: { provider: string; id: string } | null;
  availableModels: RemoteModelOption[];
  skills: RemoteSkill[];
  thinkingLevel: string;
  /** Applied task mode id (null = baseline / no behavioural mode). */
  taskMode?: string | null;
  /** Task-mode presets the host will accept in `thread.setMode`. */
  availableModes?: RemoteTaskModeOption[];
  /** Context-window usage (mirrors the desktop ring). `tokens` is null right
   * after a compaction until the next LLM response; `estimatedTokens` then
   * carries the post-compaction estimate. */
  contextUsage?: RemoteContextUsage | null;
  messages: RemoteMessage[];
  nextSeq: number;
}

/** Context-window usage as reported by pi's `get_session_stats`. */
export interface RemoteContextUsage {
  /** Used tokens (null = pi refuses to guess after a compaction). */
  tokens: number | null;
  /** Total window size; 0 when the model is unknown. */
  contextWindow: number;
  /** Raw float percent from pi (null when tokens are unknown). */
  percent: number | null;
  /** Post-compaction estimate, when the host has one. */
  estimatedTokens?: number | null;
}

/** A task-mode preset as seen from the phone: display metadata + the parameter
 * summary, never the full behavioural instructions (the host owns those). */
export interface RemoteTaskModeOption {
  id: string;
  name: string;
  /** One-line parameter summary, e.g. "沙盒 · 低思考". */
  summary?: string;
  permission?: string;
  thinking?: string;
  /** Hard read-only floor (research/review) — the phone shows it as such. */
  enforce?: "readonly";
}

/** A model option intentionally contains only display metadata. It never
 * carries provider credentials or host configuration. */
export interface RemoteModelOption {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

/** A host-installed skill exposed as a safe slash invocation. The host path
 * is deliberately omitted; `command` is validated before it crosses the
 * remote boundary. */
export interface RemoteSkill {
  name: string;
  command: string;
  description?: string;
}

export interface RemoteThreadEventPayload {
  kind: string;
  data?: Record<string, unknown>;
}

export interface RemoteUiRequest {
  id: string;
  method: "confirm" | "select" | "input" | "editor" | "notify" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  [key: string]: unknown;
}

/**
 * S7 WebPush：浏览器 PushSubscription（device→host，经 E2E 加密通道上报；host
 * 存本地并经 push.subscribe 控制帧同步给 relay）。endpoint/keys 是推送路由元数据，
 * 不含会话内容。
 */
export interface RemotePushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface RemoteDeviceInfo {
  deviceId: string;
  name: string;
  connectedAt: number;
  authenticated: boolean;
}

export class RemoteProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteProtocolError";
    this.code = code;
  }
}

export function makeEnvelope<T>(type: string, sessionId: string, payload?: T, extra: Partial<RemoteEnvelope<T>> = {}): RemoteEnvelope<T> {
  return {
    v: REMOTE_PROTOCOL_VERSION,
    type,
    sessionId,
    sentAt: Date.now(),
    ...(payload === undefined ? {} : { payload }),
    ...extra,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseEnvelope(raw: string | unknown): RemoteEnvelope {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 2_000_000) throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "Remote message is too large");
    try {
      value = JSON.parse(raw);
    } catch {
      throw new RemoteProtocolError("INVALID_JSON", "Remote message is not valid JSON");
    }
  }
  if (!isRecord(value)) throw new RemoteProtocolError("INVALID_REQUEST", "Remote message must be an object");
  if (value.v !== REMOTE_PROTOCOL_VERSION) throw new RemoteProtocolError("UNSUPPORTED_VERSION", "Unsupported remote protocol version");
  if (typeof value.type !== "string" || value.type.length === 0 || value.type.length > 80) {
    throw new RemoteProtocolError("INVALID_REQUEST", "Remote message type is invalid");
  }
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0 || value.sessionId.length > 128) {
    throw new RemoteProtocolError("INVALID_REQUEST", "Remote session id is invalid");
  }
  if (typeof value.sentAt !== "number" || !Number.isSafeInteger(value.sentAt)) {
    throw new RemoteProtocolError("INVALID_REQUEST", "Remote timestamp is invalid");
  }
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || value.requestId.length > 128)) {
    throw new RemoteProtocolError("INVALID_REQUEST", "Remote request id is invalid");
  }
  if (value.threadId !== undefined && (typeof value.threadId !== "string" || value.threadId.length > 128)) {
    throw new RemoteProtocolError("INVALID_REQUEST", "Remote thread id is invalid");
  }
  return value as RemoteEnvelope;
}

export function responseFor<T>(request: RemoteEnvelope, payload: T): RemoteEnvelope<T> {
  return makeEnvelope(`${request.type}.result`, request.sessionId, payload, { requestId: request.requestId });
}

export function errorFor(request: RemoteEnvelope, code: string, message: string): RemoteEnvelope {
  return makeEnvelope(`${request.type}.result`, request.sessionId, undefined, {
    requestId: request.requestId,
    error: { code, message },
  });
}
