/**
 * S6.2 发送控制：prompt/steer/followUp + abort + setPermission，带 claimWrite 租约管理。
 *
 * 主机端语义（RemoteService）：
 *   - thread.claimWrite → 30s 租约；他人持有且未过期时 THREAD_BUSY
 *   - prompt/steer/followUp/abort/setPermission/ui.respond 都过 assertWriter：
 *     无租约或已过期 → WRITE_CLAIM_REQUIRED（并删除死租约）；成功则滑动续期 30s
 *   - 连接断开时主机删除该连接的租约 → 重连后必须重新 claim
 *
 * PWA 策略：本地记录 claim 时间，提前 5s 主动重取；写操作失败且为
 * WRITE_CLAIM_REQUIRED（自己的租约过期/被断连清掉）→ 强制重取一次并重试。
 * THREAD_BUSY = 其他设备正持有 → 不自动抢占，原样上抛给 UI 提示。
 */

import type { RemotePermission } from "../../../shared/protocol";
import { Requester, type RequestTransport } from "./requester";

export type SendMode = "prompt" | "steer" | "followUp";

const DEFAULT_LEASE_MS = 30_000; // host-side lease (service.ts)
/** Re-claim proactively once we've used up this fraction of the lease. */
const REFRESH_FRACTION = 0.8;

function isProtocolError(error: unknown, code: string): boolean {
  return error instanceof Error && error.message.startsWith(`${code}: `);
}

export interface ThreadActionsOptions {
  requestTimeoutMs?: number;
  onStaleConnection?: () => void;
  /** Must match the host's lease (30s default); injectable for tests. */
  leaseMs?: number;
  /** Fires after every successful claimWrite (initial + refreshes). */
  onClaim?: () => void;
}

export class ThreadActions {
  private readonly requester: Requester;
  /** Local timestamp of the last successful claim/refresh (host slides it on every write). */
  private claimedAt = 0;
  private readonly leaseMs: number;
  private readonly onClaim?: () => void;

  constructor(client: RequestTransport, threadId: string, options: ThreadActionsOptions = {}) {
    this.requester = new Requester(client, {
      requestTimeoutMs: options.requestTimeoutMs,
      onStaleConnection: options.onStaleConnection,
      threadId, // envelope-level — host's requiredThread reads it there
    });
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.onClaim = options.onClaim;
  }

  private claimValid(): boolean {
    return Date.now() - this.claimedAt < this.leaseMs * REFRESH_FRACTION;
  }

  private async ensureClaim(force = false): Promise<void> {
    if (!force && this.claimValid()) return;
    await this.requester.request("thread.claimWrite", {}, "claimWrite");
    this.claimedAt = Date.now();
    this.onClaim?.();
  }

  /** Run a writer-gated request with the claim/re-claim-once pattern. */
  private async writeRequest<T>(type: string, payload: Record<string, unknown>, label: string): Promise<T> {
    try {
      await this.ensureClaim();
      const result = await this.requester.request<T>(type, payload, label);
      this.claimedAt = Date.now(); // host's assertWriter slid the lease on success
      return result;
    } catch (error) {
      if (!isProtocolError(error, "WRITE_CLAIM_REQUIRED")) throw error;
      // Our own lease expired or was dropped by a reconnect — re-claim once and retry.
      await this.ensureClaim(true);
      const result = await this.requester.request<T>(type, payload, label);
      this.claimedAt = Date.now();
      return result;
    }
  }

  /**
   * Send text (optionally with image attachments): prompt (idle) / steer
   * (running) / followUp (queued after run). Images are base64 payloads in the
   * host's RemoteImageInput shape — the pi bridge forwards them to the model.
   */
  send(text: string, mode: SendMode, images?: { data: string; mimeType: string }[], files?: { name: string; mimeType?: string; data: string }[]): Promise<unknown> {
    const trimmed = text.trim();
    if (!trimmed && !(images && images.length) && !(files && files.length)) throw new Error("empty message");
    return this.writeRequest(`thread.${mode}`, {
      text: trimmed,
      ...(images && images.length ? { images } : {}),
      ...(files && files.length ? { files } : {}),
    }, mode);
  }

  /**
   * Transcribe a recorded voice memo (base64 WAV, 16 kHz mono PCM16) via the
   * host's STT relay → voice-stack gateway. Read-only: no write lease needed.
   */
  transcribe(audioB64: string, sampleRate: number): Promise<{ text: string }> {
    return this.requester.request("stt.transcribe", { audioB64, sampleRate }, "transcribe", 30_000);
  }

  abort(): Promise<unknown> {
    return this.writeRequest("thread.abort", {}, "abort");
  }

  /** Switch sandbox/full; resolves with the updated snapshot. */
  setPermission(permission: RemotePermission): Promise<{ snapshot?: unknown }> {
    return this.writeRequest("thread.setPermission", { permission }, "setPermission");
  }

  /**
   * Switch the thread's model (host validates the provider/model pair and
   * rejects unknown ones). No model_changed event exists host-side, so the
   * caller applies the returned snapshot locally — the next resync restores
   * the host's truth either way.
   */
  setModel(provider: string, modelId: string): Promise<{ snapshot?: { model?: { provider: string; id: string } | null } }> {
    return this.writeRequest("thread.setModel", { provider, modelId }, "setModel");
  }

  /**
   * Apply a task-mode preset (permission + thinking + behaviour content live
   * host-side). An empty modeId clears the mode. The host broadcasts the
   * resulting config to every client, so the phone's chips update from that
   * event rather than from this response.
   */
  setMode(modeId: string): Promise<{ snapshot?: unknown }> {
    return this.writeRequest("thread.setMode", { modeId }, "setMode");
  }

  /**
   * Answer a ui.request (approval card). Response shapes mirror the desktop
   * ExtUiModal: select → {value}, confirm → {confirmed}, input → {value},
   * cancel → {cancelled:true}. Writer-gated on the host like every write.
   */
  respondUi(requestId: string, response: Record<string, unknown>): Promise<unknown> {
    return this.writeRequest("ui.respond", { requestId, response }, "respondUi");
  }

  detach(): void {
    this.requester.detach();
  }
}
