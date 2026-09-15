import {
  errorFor,
  makeEnvelope,
  type RemoteEnvelope,
  type RemoteFileInput,
  type RemoteImageInput,
  RemoteProtocolError,
  responseFor,
  type RemotePermission,
  type RemotePushSubscription,
  type RemoteThreadEventPayload,
  type RemoteThreadSnapshot,
} from "./protocol";

export interface RemoteBackend {
  listProjects(): Promise<unknown>;
  listThreads(projectId: string): Promise<unknown>;
  getThread(threadId: string, options?: { live?: boolean }): Promise<RemoteThreadSnapshot>;
  createThread(projectId: string, name?: string, permission?: RemotePermission): Promise<RemoteThreadSnapshot>;
  setPermission(threadId: string, permission: RemotePermission): Promise<RemoteThreadSnapshot>;
  setModel(threadId: string, provider: string, modelId: string): Promise<RemoteThreadSnapshot>;
  /** Apply a task-mode preset (bundles permission + thinking + behaviour).
   * Empty modeId clears the mode (back to baseline). */
  setMode(threadId: string, modeId: string): Promise<RemoteThreadSnapshot>;
  prompt(threadId: string, text: string, images?: RemoteImageInput[], files?: RemoteFileInput[]): Promise<unknown>;
  steer(threadId: string, text: string, images?: RemoteImageInput[], files?: RemoteFileInput[]): Promise<unknown>;
  followUp(threadId: string, text: string, images?: RemoteImageInput[], files?: RemoteFileInput[]): Promise<unknown>;
  abort(threadId: string): Promise<unknown>;
  fileTree(projectId: string, relativePath?: string): Promise<unknown>;
  filePreview(projectId: string, relativePath: string): Promise<unknown>;
  respondUi(threadId: string, requestId: string, payload: Record<string, unknown>): Promise<unknown>;
  /** S7 WebPush：store the device's PushSubscription and sync it to the relay. */
  storePushSubscription(deviceId: string, subscription: RemotePushSubscription): Promise<unknown>;
  /** Transcribe a phone voice memo (base64 WAV) via the local STT endpoint. */
  sttTranscribe(audioB64: string, sampleRate: number): Promise<{ text: string }>;
  subscribeThread(threadId: string, listener: (event: RemoteThreadEventPayload) => void): () => void;
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

export class RemoteService {
  private readonly subscriptions = new Map<string, Map<string, () => void>>();
  private readonly claims = new Map<string, Claim>();
  private readonly requests = new Map<string, RemoteEnvelope>();
  private readonly sequences = new Map<string, number>();
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
      if (cacheKey) this.requests.set(cacheKey, result);
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
        return responseFor(request, { snapshot: await this.backend.getThread(this.requiredThread(request)) });
      case "thread.resync":
        return responseFor(request, { snapshot: await this.backend.getThread(this.requiredThread(request), { live: true }) });
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
      case "thread.subscribe": {
        const threadId = this.requiredThread(request);
        const existing = this.subscriptions.get(context.connectionId) || new Map<string, () => void>();
        existing.get(threadId)?.();
        const unsubscribe = this.backend.subscribeThread(threadId, (event) => {
          const seq = (this.sequences.get(threadId) || 0) + 1;
          this.sequences.set(threadId, seq);
          context.send(makeEnvelope("thread.event", request.sessionId, event, { threadId, seq }));
        });
        existing.set(threadId, unsubscribe);
        this.subscriptions.set(context.connectionId, existing);
        // Opening a thread is deliberately history-first. Starting a cold Pi
        // bridge here can take several seconds and can exceed the mobile
        // request timeout. A later resync uses the live bridge when needed.
        return responseFor(request, { snapshot: await this.backend.getThread(threadId) });
      }
      case "thread.prompt":
      case "thread.steer":
      case "thread.followUp": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        // Image-only messages are legal (phone composer): empty text is fine
        // as long as at least one image rides along.
        const rawText = typeof payload.text === "string" ? payload.text.trim() : "";
        const images = this.optionalImages(payload);
        const files = this.optionalFiles(payload);
        if (!rawText && !images?.length && !files?.length) {
          throw new RemoteProtocolError("INVALID_REQUEST", "text, images or files is required");
        }
        const text = rawText;
        const result = request.type === "thread.prompt"
          ? await this.backend.prompt(threadId, text, images, files)
          : request.type === "thread.steer"
            ? await this.backend.steer(threadId, text, images, files)
            : await this.backend.followUp(threadId, text, images, files);
        return responseFor(request, result);
      }
      case "thread.abort": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        return responseFor(request, await this.backend.abort(threadId));
      }
      case "file.tree":
        return responseFor(request, await this.backend.fileTree(this.requiredString(payload, "projectId"), this.optionalString(payload, "relativePath")));
      case "file.preview":
        return responseFor(request, await this.backend.filePreview(this.requiredString(payload, "projectId"), this.requiredString(payload, "relativePath")));
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
      const data = image.data;
      const mimeType = image.mimeType;
      if (typeof data !== "string" || data.length === 0 || data.length > MAX_REMOTE_IMAGE_DATA || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", `images[${index}] has invalid or oversized base64 data`);
      }
      if (typeof mimeType !== "string" || !REMOTE_IMAGE_MIME_TYPES.has(mimeType)) {
        throw new RemoteProtocolError("INVALID_REQUEST", `images[${index}] has an unsupported MIME type`);
      }
      total += data.length;
      if (total > MAX_REMOTE_IMAGE_DATA_TOTAL) throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "Image attachments are too large");
      return { type: "image", data, mimeType };
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
      const data = file.data;
      if (typeof data !== "string" || data.length === 0 || data.length > MAX_REMOTE_FILE_DATA || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", `files[${index}] has invalid or oversized base64 data`);
      }
      const mimeType = typeof file.mimeType === "string" ? file.mimeType.slice(0, 120) : undefined;
      total += data.length;
      if (total > MAX_REMOTE_FILE_DATA_TOTAL) throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "File attachments are too large");
      return { name, ...(mimeType ? { mimeType } : {}), data };
    });
  }

  private trimRequestCache(): void {
    if (this.requests.size <= 500) return;
    const first = this.requests.keys().next().value;
    if (first) this.requests.delete(first);
  }
}
