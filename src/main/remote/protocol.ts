export const REMOTE_PROTOCOL_VERSION = 1 as const;

/**
 * 客户端能接受的**解密后内层 envelope** 长度上限（UTF-16 码元数）。
 *
 * 与 `mobile/app/.../protocol/Envelope.kt` 的 `MAX_ENVELOPE_BYTES` 必须一致
 * （scripts/test-remote-history-limit.mjs 守着这条）。
 *
 * 2026-09-25 从 2MB 提到 8MB：中继实际允许 32MB（加密帧），传输层从来不是瓶颈，
 * 2MB 只是客户端自己写死的遗留值。提高上限是为了不再因为字节预算而裁掉历史。
 * **升级顺序**（避免主机发出客户端接不住的帧）：先把两侧客户端提到 8MB，确认可用后
 * 再把主机侧 `history-limit.ts` 的 `MAX_INNER_ENVELOPE_BYTES` 也提上去。
 */
export const MAX_ENVELOPE_BYTES = 8_000_000;

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
  // 会话列表的元数据操作（手机端长按菜单用）
  "thread.rename",
  "thread.setPinned",
  "thread.delete",
  // Device-scoped (no threadId / write lease): the phone records a voice memo
  // in-browser and asks the host to transcribe it via the local STT endpoint.
  "stt.transcribe",
  "file.tree",
  "file.preview",
  // 按需取**附件字节**（视频原片不再内联进快照后，这是客户端唯一的取字节入口）。
  // 分片由客户端按 offset 推进，服务端回传实际长度与 eof。
  "attachment.fetch",
  // 申请**直连附件 URL**（能力令牌）：上行 PUT / 下行 GET+Range 都走它。
  // 拿不到（Tailscale 不可用 / 未开启直连）→ 客户端回落内联/中继分片。
  "attachment.url",
  "ui.respond",
] as const;

export type RemoteRequestType = (typeof REMOTE_REQUEST_TYPES)[number];

export type RemotePermission = "sandbox" | "full";

export interface RemoteImageInput {
  type: "image";
  /** base64。P3 起可为空串：那时用 `key` 让主机从对象库取原图（见下）。 */
  data: string;
  mimeType: string;
  /**
   * 内容 key（P3-S3a）：给了它，主机就从对象库读**原图**喂给模型，而 prompt 里只带缩略图。
   * 好处：客户端只传一遍（去重、可跨会话复用），快照也不会被大图擑爆。
   */
  key?: string;
  /** 缩略图（base64，小图）：落盘供快照/客户端用；主机读不到原图时也拿它当回落。 */
  thumbnail?: string;
  thumbnailMimeType?: string;
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
  /**
   * 可选**首帧封面**（base64）。只有当这个文件被当作视频附件处理时才会用到
   * （`attach="video"`，见 video-refs.ts）：主机把它落盘并用它当气泡封面，
   * 视频本体则改为客户端点开时按需拉（attachment.fetch）。
   */
  poster?: string;
  posterMimeType?: string;
  /**
   * 直连上传完成的附件名（P1）：带了它就**不需要 data**——字节已经在主机附件区。
   * 主机侧会校验「这个名字确实由本设备在本会话上传完成」，再交给 agent。
   */
  storedName?: string;
}

/**
 * 「已经存在主机上的附件」引用（P1 直连上传的产物）。
 *
 * 与内联的区别：客户端先用 `attachment.url` 拿写令牌，把字节 `PUT` 到主机附件区，
 * 消息里**只带名字**（零字节）—— 所以不再受 8MB 内层 envelope 与 6MB 单文件上限约束。
 * 主机侧会先校验这个名字确实是「本会话 + 本设备」上传完成的，再交给 agent。
 */
export interface RemoteStoredInput {
  /** 主机预分配并已收齐的附件名（不是原始文件名）。 */
  storedName: string;
  mimeType?: string;
}

/**
 * 手机端发送的**视频**附件（base64，内联下发）。
 *
 * 与普通文件不同：视频除了落盘交给 agent（同一条 stageClipboardFile + `<file>` 引用），
 * 还会在消息里生成一个 `video` 块，让客户端像图片一样**在对话框里直接播放**。
 * 代价是字节会进快照，所以上限卡得很死（见 service.ts 的 MAX_REMOTE_VIDEO_DATA）。
 */
export interface RemoteVideoInput {
  type: "video";
  data: string;
  mimeType: string;
  /** 原始字节数（客户端上报，主机只用于显示与预算判断） */
  size?: number;
  /** 可选首帧封面（base64，≤ VIDEO_POSTER_MAX_BYTES）——气泡里的封面就是它 */
  poster?: string;
  posterMimeType?: string;
  /** 直连上传完成的附件名（此时 `data` 为空串，字节已在主机磁盘上）。 */
  storedName?: string;
}

/**
 * 统一的**媒体附件**载荷（P3）：图 / 音 / 视 / 文件共用一条通道，`kind` 由 mime 推导。
 *
 * 为什么不按类型开通道：每加一种媒体就要动「校验 + 贯通签名 + 转发层 + 快照分发」四层，
 * 是 O(n) 增长（2026-09-28 的漏传事故就发生在 videos 贯通时）。统一后加一种类型**只扩一个
 * kind 枚举值**，协议与转发层一行不改。
 *
 * `videos[]` 保留为**兼容别名**：旧客户端照发，主机内部折算成 kind=video 走同一条路。
 * `images[]` 单独保留——图片是 pi 的模型输入契约（base64 进 prompt），不是展示媒体。
 *
 * 本轮只收**直连上传的产物**（`storedName`）；内联字节仍走各自的旧通道（videos 的 data）。
 */
export interface RemoteMediaInput {
  /** 主机附件名（内容寻址后就是 sha256 key；也可能是老的预留名）。 */
  storedName: string;
  /** 主机据此推 kind（`audio/*` → audio、`video/*` → video…）。缺失时按 label/扩展名推。 */
  mimeType?: string;
  /** 可读原名（主机也能从对象库 index 拿到，这里作兜底）。 */
  label?: string;
  /** 视频首帧封面（base64）；音频/其它不带。 */
  poster?: string;
  posterMimeType?: string;
}

/**
 * `attachment.fetch` 的一片响应。
 *
 * 为什么按片取：视频原片一旦不再内联进快照，客户端就得自己把字节拉回来；
 * 而整段几 MB 的 base64 一次性下发会顶到 8MB 的 envelope 硬上限、并且没有进度。
 * 客户端只需按 `offset + length` 循环请求，直到 `eof` 为真。
 */
export interface RemoteAttachmentChunk {
  name: string;
  /** 附件总字节数（客户端据此显示进度） */
  size: number;
  /** 本片在文件中的起始偏移 */
  offset: number;
  /** 本片实际字节数（原始，非 base64） */
  length: number;
  /** 是否已到末尾（false → 继续按 offset + length 请求） */
  eof: boolean;
  /** 本片字节（base64） */
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
  /** 是否置顶（手机端菜单据此显示「置顶 / 取消置顶」）。 */
  pinned?: boolean;
}

export interface RemoteMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text?: string;
  blocks?: Array<{
    type: "text" | "thinking" | "tool" | "image" | "video" | "audio";
    text?: string;
    name?: string;
    running?: boolean;
    result?: string;
    /** Tool call arguments, compacted to one line (host-side). Phones show this
     * in the collapsed row — without it a tool row reads as a bare "✓ bash". */
    args?: string;
    data?: string;
    mimeType?: string;
    /** 视频原始字节数（video 块用） */
    size?: number;
    /**
     * 视频的**首帧封面**（base64 图片）。快照不再下发视频本体后，气泡里的画面就靠它；
     * 没有封面（旧消息 / 发送端抽帧失败）→ 客户端退化成深色卡片 + ▶。
     */
    poster?: string;
    posterMimeType?: string;
    /**
     * 可读的原文件名（内容寻址后 `name` 是 64 位哈希，界面上显示它就没有意义了）。
     * 老消息没这个字段 → 客户端本来就只显示封面，不会退化成坏体验。
     */
    label?: string;
    /**
     * 内容寻址的 key（P3，image 块用）：快照只下发**缩略图**（几十 KB），原图由客户端
     * 拿这个 key 去申请读令牌按需拉（url 对 key 来说没有可读信息，但它是唯一标识）。
     */
    key?: string;
    /** 实时事件通道刻意剥掉本体（防大帧）——照图片语义。 */
    omitted?: boolean;
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
  /** 当前模型可选的思考档位（如 `["off","low","high"]`）；主机未上报时手机端自行推断。 */
  thinkingLevels?: string[];
  /** Applied task mode id (null = baseline / no behavioural mode). */
  taskMode?: string | null;
  /** Task-mode presets the host will accept in `thread.setMode`. */
  availableModes?: RemoteTaskModeOption[];
  /** Context-window usage (mirrors the desktop ring). `tokens` is null right
   * after a compaction until the next LLM response; `estimatedTokens` then
   * carries the post-compaction estimate. */
  contextUsage?: RemoteContextUsage | null;
  messages: RemoteMessage[];
  /**
   * true = `messages` 只是**新增部分**（客户端带了锚点 haveMessageId，主机在窗口里找到了它）。
   * 客户端应把消息**追加**到已有列表，而不是整体替换。缺省/undefined = 全量快照。
   */
  incremental?: boolean;
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
    if (raw.length > MAX_ENVELOPE_BYTES) throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "Remote message is too large");
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
