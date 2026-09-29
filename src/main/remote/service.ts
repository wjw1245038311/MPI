import {
  errorFor,
  makeEnvelope,
  type RemoteEnvelope,
  type RemoteFileInput,
  type RemoteVideoInput,
  type RemoteImageInput,
  RemoteProtocolError,
  responseFor,
  type RemotePermission,
  type RemotePushSubscription,
  type RemoteAttachmentChunk,
  type RemoteThreadEventPayload,
  type RemoteThreadSnapshot,
} from "./protocol";
import { appendDiagLog } from "../diag-log";

export interface RemoteBackend {
  listProjects(): Promise<unknown>;
  listThreads(projectId: string): Promise<unknown>;
  getThread(threadId: string, options?: { live?: boolean; haveMessageId?: string }): Promise<RemoteThreadSnapshot>;
  createThread(projectId: string, name?: string, permission?: RemotePermission): Promise<RemoteThreadSnapshot>;
  setPermission(threadId: string, permission: RemotePermission): Promise<RemoteThreadSnapshot>;
  setModel(threadId: string, provider: string, modelId: string): Promise<RemoteThreadSnapshot>;
  /** 设置思考档位（pi RPC `set_thinking_level`）；主机按当前模型可选档位校验。 */
  setThinking(threadId: string, level: string): Promise<RemoteThreadSnapshot>;
  /** Apply a task-mode preset (bundles permission + thinking + behaviour).
   * Empty modeId clears the mode (back to baseline). */
  setMode(threadId: string, modeId: string): Promise<RemoteThreadSnapshot>;
  /** Compact the thread's context (pi RPC `compact`). Long-running: the phone
   * shows a spinner from compaction_start/end events, and the refreshed
   * context usage arrives as a `context_usage` event. */
  compact(threadId: string, instructions?: string): Promise<unknown>;
  /**
   * videos 特意写成**必填**（类型是 `X | undefined`，而不是可选参数 `videos?`）。
   *
   * 2026-09-28 真机事故：新增 videos 后，中间转发层（ipc.ts 的 remoteBackend）的箭头函数
   * 只写了 4 个参数 → 第 5 个参数被**默默吞掉**，而 TS 因为“可选参数可以少传”一声不吭。
   * 症状极其难查：客户端发了 285KB 帧、主机日志记着 `videos=1`，但落盘/引用全都没有。
   * 改成必填后，同一类漏传会直接**编译失败**。
   */
  prompt(threadId: string, text: string, images: RemoteImageInput[] | undefined, files: RemoteFileInput[] | undefined, videos: RemoteVideoInput[] | undefined): Promise<unknown>;
  steer(threadId: string, text: string, images: RemoteImageInput[] | undefined, files: RemoteFileInput[] | undefined, videos: RemoteVideoInput[] | undefined): Promise<unknown>;
  followUp(threadId: string, text: string, images: RemoteImageInput[] | undefined, files: RemoteFileInput[] | undefined, videos: RemoteVideoInput[] | undefined): Promise<unknown>;
  abort(threadId: string): Promise<unknown>;
  /** 重命名会话（pi RPC `set_session_name`）。 */
  renameThread(threadId: string, name: string): Promise<unknown>;
  /** 置顶 / 取消置顶（写 config.pinnedThreads；草稿会话不可置顶）。 */
  setThreadPinned(threadId: string, pinned: boolean): Promise<unknown>;
  /** 删除会话（与桌面端同一实现：停桥 → 移入回收站 → 清理 config）。 */
  deleteThread(threadId: string): Promise<unknown>;
  fileTree(projectId: string, relativePath?: string): Promise<unknown>;
  filePreview(projectId: string, relativePath: string): Promise<unknown>;
  /**
   * 按需取附件的一段字节（远程客户端播放视频原片用）。
   *
   * **作用域校验在 backend 内**：名字必须出现在这个会话里（引用过才算），
   * 否则任何配对设备都能拿名字遍历整个附件区（见 ipc.ts 的附件允许表）。
   * 名字非法 / 文件已被清理 / 不属于该会话 → 抛 NOT_FOUND。
   */
  fetchAttachment(threadId: string, name: string, offset: number): Promise<RemoteAttachmentChunk>;
  /**
   * 签发一个**直连附件令牌**（能力 URL）：上行 `PUT` / 下行 `GET+Range`。
   *
   * read：name 必须是本会话引用过的附件（沿用 attachmentNameAllowed）；
   * write：主机预分配名字，字节到齐后客户端在消息里只带 `storedName`。
   * 直连不可用（Tailscale 未就绪等）→ 抛 DIRECT_UNAVAILABLE，客户端回落。
   */
  issueAttachmentUrl(
    threadId: string,
    deviceId: string,
    input: { mode: "read" | "write"; name?: string; originalName?: string; mimeType?: string; size?: number; sha256?: string; workspace?: boolean },
  ): Promise<{
    url: string;
    token: string;
    name: string;
    expiresAt: number;
    key?: string;
    label?: string;
    deduped?: boolean;
    /** 「降落到工作区」时的最终绝对路径（agent 用它读文件）。 */
    workspacePath?: string;
    workspaceName?: string;
  }>;
  respondUi(threadId: string, requestId: string, payload: Record<string, unknown>): Promise<unknown>;
  /** S7 WebPush：store the device's PushSubscription and sync it to the relay. */
  storePushSubscription(deviceId: string, subscription: RemotePushSubscription): Promise<unknown>;
  /** Transcribe a phone voice memo (base64 WAV) via the local STT endpoint. */
  sttTranscribe(audioB64: string, sampleRate: number): Promise<{ text: string }>;
  subscribeThread(threadId: string, listener: (event: RemoteThreadEventPayload, seq: number) => void): () => void;
  /** 后台预热会话（手机打开会话时调用）：让主机在后台建立/复用 pi 桥，
   * 就绪后由主机推送 context_usage。**绝不能 await**——冷启动桥可能超过手机端
   * 请求超时（subscribe 注释里记过这个坑）。 */
  warmThread?(threadId: string): Promise<void>;
}
export interface RemoteClientContext {
  connectionId: string;
  deviceId: string;
  send: (message: RemoteEnvelope) => void;
}

/** S7 WebPush：basic shape check for a browser PushSubscription (the relay re-validates). */
export function isPushSubscriptionShape(value: unknown): value is RemotePushSubscription {
  const sub = value as RemotePushSubscription | undefined;
  if (!sub || typeof sub !== "object") return false;
  if (typeof sub.endpoint !== "string" || !/^https?:\/\//.test(sub.endpoint)) return false;
  if (!sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return false;
  return true;
}

function safeErrorMessage(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|var|tmp|workspace)\/)[^\s"'<>`]*/gi, "[path]")
    .slice(0, 2_000);
}

interface Claim {
  connectionId: string;
  deviceId: string;
  expiresAt: number;
}

const REMOTE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_REMOTE_IMAGES = 3;
/** 文件附件：最多 3 个，单个 base64 ≤ 8MB（约 6MB 原文件），合计 ≤ 16MB。 */
const MAX_REMOTE_FILES = 3;
const MAX_REMOTE_FILE_DATA = 8_000_000;
const MAX_REMOTE_FILE_DATA_TOTAL = 16_000_000;
const REMOTE_FILE_NAME_MAX = 180;
const MAX_REMOTE_IMAGE_DATA = 1_200_000;
const MAX_REMOTE_IMAGE_DATA_TOTAL = 1_500_000;
/**
 * 视频附件：每条消息最多 1 个，单个 base64 ≤ 4.2MB（≈3MB 原始字节，与 PWA 的
 * MAX_VIDEO_BYTES 对应）。
 *
 * 为什么卡这么死：视频是**内联**下发的（要「像图片一样在对话框里直接看」），字节会进
 * 每次快照；而快照有 8MB 硬上限（MAX_INNER_ENVELOPE_BYTES），PWA 还会把快照写进
 * IndexedDB 缓存。放宽这个值之前先读 history-limit.ts 的预算逻辑。
 */
const MAX_REMOTE_VIDEOS = 1;
const MAX_REMOTE_VIDEO_DATA = 4_200_000;

/**
 * 首帧封面的 base64 上限（与 video-refs.ts 的 VIDEO_POSTER_MAX_BYTES 对应，
 * 留出 4/3 膨胀与误差余量）。
 */
const MAX_REMOTE_POSTER_DATA = 240_000;
const REMOTE_POSTER_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * 不进 request 缓存（去重重试缓存）的请求类型。
 *
 * `attachment.fetch` 的响应是几百 KB 的分片，而缓存上限是 500 条 —— 一个 20MB 的
 * 视频就有 40 片，几轮下来能把内存吃掉几百 MB。取字节是幂等的，重试的代价只是再读一次盘。
 */
const NON_CACHED_REQUEST_TYPES = new Set<string>(["attachment.fetch"]);

/** 直连上传的单个附件上限（与 attachment-server.ts 的 ATTACHMENT_UPLOAD_MAX_BYTES 对齐）。 */
const MAX_DIRECT_UPLOAD_BYTES = 128 * 1024 * 1024;

export class RemoteService {
  private readonly subscriptions = new Map<string, Map<string, () => void>>();
  private readonly claims = new Map<string, Claim>();
  private readonly requests = new Map<string, RemoteEnvelope>();
  /** Writer-lease duration; injectable so tests don't wait the real 30s. */
  private readonly leaseMs: number;

  constructor(backend: RemoteBackend, options: { leaseMs?: number } = {}) {
    this.backend = backend;
    this.leaseMs = options.leaseMs ?? 30_000;
  }
  private readonly backend: RemoteBackend;

  disconnect(connectionId: string): void {
    if (connectionId === "__all__") {
      for (const id of [...this.subscriptions.keys()]) this.disconnect(id);
      this.claims.clear();
      return;
    }
    const entries = this.subscriptions.get(connectionId);
    entries?.forEach((unsubscribe) => unsubscribe());
    this.subscriptions.delete(connectionId);
    for (const [threadId, claim] of this.claims) {
      if (claim.connectionId === connectionId) this.claims.delete(threadId);
    }
  }

  async handle(request: RemoteEnvelope, context: RemoteClientContext): Promise<void> {
    const cacheKey = request.requestId ? `${context.deviceId}:${request.requestId}` : "";
    if (cacheKey && this.requests.has(cacheKey)) {
      context.send(this.requests.get(cacheKey)!);
      return;
    }

    try {
      const result = await this.dispatch(request, context);
      if (!result) return;
      // 分片响应动辄几百 KB，而请求缓存能存 500 条（约等于几百 MB 内存）——
      // 只对**幂等的取字节**这一条不缓存：重试的成本只是再读一次盘。
      if (cacheKey && !NON_CACHED_REQUEST_TYPES.has(request.type)) this.requests.set(cacheKey, result);
      context.send(result);
      this.trimRequestCache();
    } catch (error) {
      const e = error instanceof RemoteProtocolError
        ? error
        : new RemoteProtocolError("INTERNAL_ERROR", safeErrorMessage(error instanceof Error ? error.message : String(error)));
      const result = errorFor(request, e.code, safeErrorMessage(e.message));
      if (cacheKey) this.requests.set(cacheKey, result);
      context.send(result);
    }
  }

  private async dispatch(request: RemoteEnvelope, context: RemoteClientContext): Promise<RemoteEnvelope | null> {
    const payload = (request.payload || {}) as Record<string, unknown>;
    switch (request.type) {
      case "projects.list":
        return responseFor(request, { projects: await this.backend.listProjects() });
      case "threads.list":
        return responseFor(request, { threads: await this.backend.listThreads(this.requiredString(payload, "projectId")) });
      case "thread.get":
        return responseFor(request, {
          snapshot: await this.backend.getThread(this.requiredThread(request), {
            haveMessageId: this.optionalString(payload, "haveMessageId"),
          }),
        });
      case "thread.resync":
        appendDiagLog(
          `remote-req resync conn=${context.connectionId.slice(0, 24)} thread=${this.requiredThread(request).slice(0, 12)}`,
        );
        return responseFor(request, {
          snapshot: await this.backend.getThread(this.requiredThread(request), {
            live: true,
            // 客户端本地已有到哪条：有就只回新增（增量快照，见 history-limit.ts）
            haveMessageId: this.optionalString(payload, "haveMessageId"),
          }),
        });
      case "thread.create":
        return responseFor(request, {
          snapshot: await this.backend.createThread(
            this.requiredString(payload, "projectId"),
            this.optionalString(payload, "name"),
            this.optionalPermission(payload, "permission") || "sandbox",
          ),
        });
      case "thread.claimWrite": {
        const threadId = this.requiredThread(request);
        const existing = this.claims.get(threadId);
        if (existing && existing.expiresAt > Date.now() && existing.connectionId !== context.connectionId) {
          throw new RemoteProtocolError("THREAD_BUSY", "Thread is being edited by another device");
        }
        const expiresAt = Date.now() + this.leaseMs;
        this.claims.set(threadId, { connectionId: context.connectionId, deviceId: context.deviceId, expiresAt });
        return responseFor(request, { threadId, expiresAt, deviceId: context.deviceId });
      }
      case "thread.setPermission": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        return responseFor(request, {
          snapshot: await this.backend.setPermission(threadId, this.requiredPermission(payload, "permission")),
        });
      }
      case "thread.setModel": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        const provider = this.requiredShortString(payload, "provider");
        const modelId = this.requiredShortString(payload, "modelId");
        return responseFor(request, {
          snapshot: await this.backend.setModel(threadId, provider, modelId),
        });
      }
      case "thread.setMode": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        // modeId 允许是空串（= 清除模式，回到基线行为）。
        const modeId = typeof payload.modeId === "string" ? payload.modeId.slice(0, 80) : "";
        return responseFor(request, {
          snapshot: await this.backend.setMode(threadId, modeId),
        });
      }
      case "thread.setThinking": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        const level = this.requiredShortString(payload, "level");
        return responseFor(request, {
          snapshot: await this.backend.setThinking(threadId, level),
        });
      }
      case "thread.compact": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        const instructions = typeof payload.instructions === "string" ? payload.instructions.slice(0, 2_000) : undefined;
        return responseFor(request, { compacted: await this.backend.compact(threadId, instructions) });
      }
      case "thread.subscribe": {
        const threadId = this.requiredThread(request);
        // 取证：手机订阅/重订阅时刻（它与 remote-conn open/closed 一起能定位事件丢失窗口）
        appendDiagLog(`remote-req subscribe conn=${context.connectionId.slice(0, 24)} thread=${threadId.slice(0, 12)}`);
        const existing = this.subscriptions.get(context.connectionId) || new Map<string, () => void>();
        existing.get(threadId)?.();
        const unsubscribe = this.backend.subscribeThread(threadId, (event, seq) => {
          // seq 由 RemoteEventHub 按线程统一分配（每个事件一次，对所有订阅者
          // 相同值）——绝不能在这里自己递增，否则多设备同时看一个会话时，
          // 各自的序号会交错，客户端把每个事件都当成缺号，疯狂 resync。
          context.send(makeEnvelope("thread.event", request.sessionId, event, { threadId, seq }));
        });
        existing.set(threadId, unsubscribe);
        this.subscriptions.set(context.connectionId, existing);
        // Opening a thread is deliberately history-first. Starting a cold Pi
        // bridge here can take several seconds and can exceed the mobile
        // request timeout. A later resync uses the live bridge when needed.
        const snapshot = await this.backend.getThread(threadId, {
          // 开会话时若带着本地缓存锚点，主机只回新增（不会每次重传整段历史）
          haveMessageId: this.optionalString(payload, "haveMessageId"),
        });
        // 但历史快照拿不到上下文用量（那是桥里的 pi 状态）。于是不阻塞响应地预热：
        // 桥就绪后主机推 context_usage，手机端的用量 chip 就有数了（此前一直是「—」）。
        void this.backend.warmThread?.(threadId).catch(() => {});
        return responseFor(request, { snapshot });
      }
      case "thread.prompt":
      case "thread.steer":
      case "thread.followUp": {
        const threadId = this.requiredThread(request);
        // 取证（2026-09-28）：把**附件明细**一起记下。原先只记类型与线程，导致
        // 「中继看到了 381KB 大帧、服务层却当纯文本处理」这种事故无从分辨是
        // 客户端没发、还是主机没读——这两行对齐就能定死在哪一层。
        appendDiagLog(
          `remote-req ${request.type} conn=${context.connectionId.slice(0, 24)} thread=${threadId.slice(0, 12)}` +
            ` payload=${JSON.stringify(payload).length}B keys=${Object.keys(payload).join(",").slice(0, 80)}` +
            ` images=${Array.isArray(payload.images) ? payload.images.length : 0}` +
            ` videos=${Array.isArray(payload.videos) ? payload.videos.length : 0}` +
            ` files=${Array.isArray(payload.files) ? payload.files.length : 0}`,
        );
        this.assertWriter(threadId, context);
        // Image-only messages are legal (phone composer): empty text is fine
        // as long as at least one image rides along.
        const rawText = typeof payload.text === "string" ? payload.text.trim() : "";
        const images = this.optionalImages(payload);
        const files = this.optionalFiles(payload);
        const videos = this.optionalVideos(payload);
        if (!rawText && !images?.length && !files?.length && !videos?.length) {
          throw new RemoteProtocolError("INVALID_REQUEST", "text, images, files or videos is required");
        }
        const text = rawText;
        const result = request.type === "thread.prompt"
          ? await this.backend.prompt(threadId, text, images, files, videos)
          : request.type === "thread.steer"
            ? await this.backend.steer(threadId, text, images, files, videos)
            : await this.backend.followUp(threadId, text, images, files, videos);
        return responseFor(request, result);
      }
      case "thread.abort": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        return responseFor(request, await this.backend.abort(threadId));
      }
      case "thread.rename": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        const name = this.requiredString(payload, "name").trim();
        if (!name || name.length > 120) throw new RemoteProtocolError("INVALID_REQUEST", "name is invalid");
        return responseFor(request, await this.backend.renameThread(threadId, name));
      }
      case "thread.setPinned": {
        const threadId = this.requiredThread(request);
        if (typeof payload.pinned !== "boolean") {
          throw new RemoteProtocolError("INVALID_REQUEST", "pinned must be a boolean");
        }
        return responseFor(request, await this.backend.setThreadPinned(threadId, payload.pinned));
      }
      case "thread.delete": {
        const threadId = this.requiredThread(request);
        // 破坏性操作要写租约：别的设备正在操作这个会话时不要抢着删
        this.assertWriter(threadId, context);
        return responseFor(request, await this.backend.deleteThread(threadId));
      }
      case "file.tree":
        return responseFor(request, await this.backend.fileTree(this.requiredString(payload, "projectId"), this.optionalString(payload, "relativePath")));
      case "file.preview":
        return responseFor(request, await this.backend.filePreview(this.requiredString(payload, "projectId"), this.requiredString(payload, "relativePath")));
      case "attachment.url": {
        // 只申请一个 URL（不搬字节）：读不需要写租约；写也不抢会话编辑权（上传期间
        // 用户可能还在正常聊天），作用域由令牌绑定（会话 + 设备）。
        const threadId = this.requiredThread(request);
        const mode = payload.mode === "write" ? ("write" as const) : payload.mode === "read" ? ("read" as const) : null;
        if (!mode) throw new RemoteProtocolError("INVALID_REQUEST", "mode must be read or write");
        const name = mode === "read" ? this.requiredShortString(payload, "name") : this.optionalString(payload, "name");
        const originalName = this.optionalString(payload, "originalName");
        const mimeType = this.optionalString(payload, "mimeType");
        const rawSize = payload.size;
        const size = typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize > 0 ? Math.floor(rawSize) : undefined;
        // 内容寻址（P1）：客户端先算好的整文件 SHA-256（小写 hex，64 位）；形状不对就当作没给。
        const rawSha = typeof payload.sha256 === "string" ? payload.sha256.trim().toLowerCase() : "";
        const sha256 = /^[a-f0-9]{64}$/.test(rawSha) ? rawSha : undefined;
        // 「降落到工作区」（P3-S2）：只有写方向有意义（读字节不会往工作区写东西）。
        const workspace = payload.workspace === true && mode === "write";
        if (size !== undefined && size > MAX_DIRECT_UPLOAD_BYTES) {
          throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", `Attachment is too large (maximum ${Math.floor(MAX_DIRECT_UPLOAD_BYTES / 1024 / 1024)} MB)`);
        }
        return responseFor(request, {
          direct: await this.backend.issueAttachmentUrl(threadId, context.deviceId, {
            mode,
            ...(name ? { name } : {}),
            ...(originalName ? { originalName } : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(size ? { size } : {}),
            ...(sha256 ? { sha256 } : {}),
            ...(workspace ? { workspace: true } : {}),
          }),
        });
      }
      case "attachment.fetch": {
        // 只读取字节：不要写租约（读字节不该抢会话的编辑权），但必须带 threadId——
        // 作用域校验以它为界（「这个附件被这个会话引用过吗」）。
        const threadId = this.requiredThread(request);
        const name = this.requiredShortString(payload, "name");
        const rawOffset = payload.offset ?? 0;
        if (typeof rawOffset !== "number" || !Number.isFinite(rawOffset) || rawOffset < 0) {
          throw new RemoteProtocolError("INVALID_REQUEST", "offset must be a non-negative number");
        }
        return responseFor(request, {
          chunk: await this.backend.fetchAttachment(threadId, name, Math.floor(rawOffset)),
        });
      }
      case "ui.respond": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        const uiRequestId = this.requiredString(payload, "requestId");
        const response = payload.response;
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new RemoteProtocolError("INVALID_REQUEST", "UI response must be an object");
        return responseFor(request, await this.backend.respondUi(threadId, uiRequestId, response as Record<string, unknown>));
      }
      case "push.subscribe": {
        // S7 WebPush: device-scoped (no thread). The subscription is routing
        // metadata only — the relay re-validates shape before storing.
        const subscription = payload.subscription;
        if (!isPushSubscriptionShape(subscription)) throw new RemoteProtocolError("INVALID_REQUEST", "subscription is required");
        return responseFor(request, await this.backend.storePushSubscription(context.deviceId, subscription));
      }
      case "stt.transcribe": {
        // Device-scoped read-only op: no threadId, no write lease. The PWA
        // encodes a 16 kHz mono PCM16 WAV in-browser; the host forwards it to
        // the voice-stack gateway's localhost STT endpoint.
        const audioB64 = payload.audioB64;
        if (typeof audioB64 !== "string" || !audioB64.length || audioB64.length > 8 * 1024 * 1024) {
          throw new RemoteProtocolError("INVALID_REQUEST", "audioB64 must be a base64 string of at most 8 MB");
        }
        const sampleRate = typeof payload.sampleRate === "number" && Number.isFinite(payload.sampleRate) ? payload.sampleRate : 16000;
        return responseFor(request, await this.backend.sttTranscribe(audioB64, sampleRate));
      }
      default:
        throw new RemoteProtocolError("UNSUPPORTED", `Unsupported remote command: ${request.type}`);
    }
  }

  private assertWriter(threadId: string, context: RemoteClientContext): void {
    const claim = this.claims.get(threadId);
    if (!claim || claim.expiresAt <= Date.now()) {
      this.claims.delete(threadId);
      throw new RemoteProtocolError("WRITE_CLAIM_REQUIRED", "Claim the thread before writing");
    }
    if (claim.connectionId !== context.connectionId) throw new RemoteProtocolError("THREAD_BUSY", "Thread is being edited by another device");
    claim.expiresAt = Date.now() + this.leaseMs;
  }

  private requiredThread(request: RemoteEnvelope): string {
    if (!request.threadId) throw new RemoteProtocolError("INVALID_REQUEST", "threadId is required");
    return request.threadId;
  }

  private requiredString(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    if (typeof value !== "string" || !value.trim()) throw new RemoteProtocolError("INVALID_REQUEST", `${key} is required`);
    return value.trim();
  }

  private requiredShortString(payload: Record<string, unknown>, key: string): string {
    const value = this.requiredString(payload, key);
    if (value.length > 256) throw new RemoteProtocolError("INVALID_REQUEST", `${key} is too long`);
    return value;
  }

  private optionalString(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private optionalPermission(payload: Record<string, unknown>, key: string): RemotePermission | undefined {
    const value = payload[key];
    return value === "sandbox" || value === "full" ? value : undefined;
  }

  private requiredPermission(payload: Record<string, unknown>, key: string): RemotePermission {
    const value = this.optionalPermission(payload, key);
    if (!value) throw new RemoteProtocolError("INVALID_REQUEST", `${key} must be sandbox or full`);
    return value;
  }

  private optionalImages(payload: Record<string, unknown>): RemoteImageInput[] | undefined {
    const value = payload.images;
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_REMOTE_IMAGES) {
      throw new RemoteProtocolError("INVALID_REQUEST", `images must contain at most ${MAX_REMOTE_IMAGES} items`);
    }
    let total = 0;
    return value.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new RemoteProtocolError("INVALID_REQUEST", `images[${index}] is invalid`);
      }
      const image = item as Record<string, unknown>;
      // 宽容旧客户端：曾经有版本只发 {data, mimeType}（漏 type），手机端发图恒失败。
      // 显式传了错值仍拒绝（不猜）。
      if (image.type !== undefined && image.type !== "image") {
        throw new RemoteProtocolError("INVALID_REQUEST", `images[${index}].type must be image`);
      }
      // P3-S3a：带内容 key 的图片可以**不带 base64**（主机从对象库取原图）。
      const rawKey = typeof image.key === "string" ? image.key.trim().toLowerCase() : "";
      const key = /^[a-f0-9]{64}$/.test(rawKey) ? rawKey : undefined;
      const rawThumb = typeof image.thumbnail === "string" ? image.thumbnail : "";
      const thumbnail =
        rawThumb && rawThumb.length <= MAX_REMOTE_IMAGE_DATA && /^[A-Za-z0-9+/]*={0,2}$/.test(rawThumb) ? rawThumb : undefined;
      const data = image.data;
      const mimeType = image.mimeType;
      if (typeof data !== "string" || data.length > MAX_REMOTE_IMAGE_DATA) {
        throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", `images[${index}] has invalid or oversized base64 data`);
      }
      if (!data && !key) {
        throw new RemoteProtocolError("INVALID_REQUEST", `images[${index}] needs either inline data or a content key`);
      }
      if (data && !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new RemoteProtocolError("INVALID_REQUEST", `images[${index}] has invalid base64 data`);
      }
      if (typeof mimeType !== "string" || !REMOTE_IMAGE_MIME_TYPES.has(mimeType)) {
        throw new RemoteProtocolError("INVALID_REQUEST", `images[${index}] has an unsupported MIME type`);
      }
      total += data.length + (thumbnail?.length || 0);
      if (total > MAX_REMOTE_IMAGE_DATA_TOTAL) throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "Image attachments are too large");
      return {
        type: "image",
        data,
        mimeType,
        ...(key ? { key } : {}),
        ...(thumbnail ? { thumbnail } : {}),
        ...(typeof image.thumbnailMimeType === "string" && REMOTE_IMAGE_MIME_TYPES.has(image.thumbnailMimeType)
          ? { thumbnailMimeType: image.thumbnailMimeType }
          : {}),
      };
    });
  }

  /**
   * 文件附件校验：张数/体积/名字长度/名字字符/附件类型都卡死，避免手机端传坏数据
   * 到主进程（落盘前必须可信）。
   */
  private optionalFiles(payload: Record<string, unknown>): RemoteFileInput[] | undefined {
    const value = payload.files;
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_REMOTE_FILES) {
      throw new RemoteProtocolError("INVALID_REQUEST", `files must contain at most ${MAX_REMOTE_FILES} items`);
    }
    let total = 0;
    return value.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new RemoteProtocolError("INVALID_REQUEST", `files[${index}] is invalid`);
      }
      const file = item as Record<string, unknown>;
      const name = typeof file.name === "string" ? file.name.trim() : "";
      if (!name || name.length > REMOTE_FILE_NAME_MAX) {
        throw new RemoteProtocolError("INVALID_REQUEST", `files[${index}].name is invalid`);
      }
      const data = typeof file.data === "string" ? file.data : "";
      // storedName（直连上传完成）→ 不需要 data；否则按内联校验（体积/字符集）。
      const storedName = typeof file.storedName === "string" ? file.storedName.trim() : "";
      if (!storedName && (!data || data.length > MAX_REMOTE_FILE_DATA || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) {
        throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", `files[${index}] has invalid or oversized base64 data`);
      }
      const mimeType = typeof file.mimeType === "string" ? file.mimeType.slice(0, 120) : undefined;
      const poster = this.optionalPoster(file, `files[${index}]`);
      if (storedName) {
        // 名字合法性由后端（附件区白名单 + 上传登记）校验，这里只做形状限制。
        if (storedName.length > REMOTE_FILE_NAME_MAX) {
          throw new RemoteProtocolError("INVALID_REQUEST", `files[${index}].storedName is invalid`);
        }
        return { name, ...(mimeType ? { mimeType } : {}), data: "", storedName, ...poster };
      }
      total += data.length;
      if (total > MAX_REMOTE_FILE_DATA_TOTAL) throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "File attachments are too large");
      return { name, ...(mimeType ? { mimeType } : {}), data, ...poster };
    });
  }

  /**
   * 可选的**首帧封面**（视频附件用）。
   *
   * 超限/类型不对一律**静默丢弃**而不是报错：封面只是观感优化，为此整条消息失败
   * （用户在跑十几次上传后才发现发不出去）得不偿失；丢了它客户端退化成深色卡片。
   */
  private optionalPoster(source: Record<string, unknown>, label: string): { poster?: string; posterMimeType?: string } {
    const poster = source.poster;
    if (poster === undefined) return {};
    if (typeof poster !== "string" || !poster || poster.length > MAX_REMOTE_POSTER_DATA) {
      appendDiagLog(`remote-poster ${label} dropped: invalid or oversized (${typeof poster === "string" ? poster.length : "non-string"})`);
      return {};
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(poster)) {
      appendDiagLog(`remote-poster ${label} dropped: not base64`);
      return {};
    }
    const posterMimeType = typeof source.posterMimeType === "string" ? source.posterMimeType.slice(0, 60).toLowerCase() : "image/jpeg";
    if (!REMOTE_POSTER_MIME_TYPES.has(posterMimeType)) {
      appendDiagLog(`remote-poster ${label} dropped: mime ${posterMimeType.slice(0, 30)}`);
      return {};
    }
    return { poster, posterMimeType };
  }

  /**
   * 视频附件（内联下发，见 protocol.ts 的 RemoteVideoInput）。
   *
   * 与 files 分开而不是混进 files：语义不同——files 里的视频只是「给 agent 读的文件」
   * （不内联、不进快照），videos 里的才会被远程客户端当成可播放的媒体。混在一起就变成
   * 靠 mime 猜意图，从 📎 入口挑的视频会意外把快照撞大。
   */
  private optionalVideos(payload: Record<string, unknown>): RemoteVideoInput[] | undefined {
    const value = payload.videos;
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_REMOTE_VIDEOS) {
      throw new RemoteProtocolError("INVALID_REQUEST", `videos must contain at most ${MAX_REMOTE_VIDEOS} items`);
    }
    return value.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new RemoteProtocolError("INVALID_REQUEST", `videos[${index}] is invalid`);
      }
      const video = item as Record<string, unknown>;
      const mimeType = typeof video.mimeType === "string" ? video.mimeType.slice(0, 120) : "";
      if (!/^video\//i.test(mimeType)) {
        throw new RemoteProtocolError("INVALID_REQUEST", `videos[${index}].mimeType must be video/*`);
      }
      const data = video.data;
      // storedName（直连上传完成）→ 字节已在主机磁盘，不再要求内联 base64。
      const storedName = typeof video.storedName === "string" ? video.storedName.trim() : "";
      if (!storedName) {
        if (typeof data !== "string" || data.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
          throw new RemoteProtocolError("INVALID_REQUEST", `videos[${index}].data must be base64`);
        }
        if (data.length > MAX_REMOTE_VIDEO_DATA) {
          throw new RemoteProtocolError(
            "PAYLOAD_TOO_LARGE",
            `videos[${index}] is too large (maximum ${Math.floor((MAX_REMOTE_VIDEO_DATA * 3) / 4 / 1000)} KB); use attachment.url for larger files`,
          );
        }
      } else if (storedName.length > REMOTE_FILE_NAME_MAX) {
        throw new RemoteProtocolError("INVALID_REQUEST", `videos[${index}].storedName is invalid`);
      }
      const size = typeof video.size === "number" && Number.isFinite(video.size) && video.size > 0 ? Math.floor(video.size) : undefined;
      const poster = this.optionalPoster(video, `videos[${index}]`);
      return {
        type: "video" as const,
        data: typeof data === "string" ? data : "",
        mimeType,
        ...(size ? { size } : {}),
        ...(storedName ? { storedName } : {}),
        ...poster,
      };
    });
  }

  private trimRequestCache(): void {
    if (this.requests.size <= 500) return;
    const first = this.requests.keys().next().value;
    if (first) this.requests.delete(first);
  }
}
