/**
 * Correlated request/response over a RelayClient (shared by HostSession and
 * ThreadSession). Requests carry a client-generated requestId; the host answers
 * with "<type>.result" echoing it. Waiters are registered BEFORE sending — on
 * localhost the reply can land before the async send path finishes, and
 * RelayClient does not buffer frames for late listeners.
 */
import { makeEnvelope } from "../../../shared/protocol";

/** The slice of RelayClient this module needs (structural typing keeps it testable). */
export interface RequestTransport {
  sendData(obj: unknown): Promise<boolean> | boolean;
  onFrame(listener: (frame: Record<string, unknown>) => void): () => void;
  isOpen(): boolean;
}

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Requester {
  private readonly pending = new Map<string, Waiter>();
  private reqCounter = 0;
  private readonly sessionId: string;
  private readonly detachFrame: () => void;

  constructor(
    private readonly client: RequestTransport,
    options: { requestTimeoutMs?: number; onStaleConnection?: () => void } = {},
  ) {
    const rand = new Uint8Array(8);
    crypto.getRandomValues(rand);
    let hex = "";
    for (const byte of rand) hex += byte.toString(16).padStart(2, "0");
    this.sessionId = `pwa-${hex}`;
    this.onStaleConnection = options.onStaleConnection;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    // Subscribe before any traffic can flow (RelayClient does not buffer frames).
    this.detachFrame = client.onFrame((frame) => this.handleFrame(frame));
  }

  private readonly requestTimeoutMs: number;
  private readonly onStaleConnection?: () => void;

  /** Resolve with the response payload; reject on error envelope / timeout / send failure. */
  request<T>(type: string, payload?: unknown, label = type): Promise<T> {
    const requestId = `req-${++this.reqCounter}-${Math.random().toString(36).slice(2, 8)}`;
    const envelope = makeEnvelope(type, this.sessionId, payload === undefined ? undefined : (payload as never), { requestId });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        // Socket still open but the host never answered — its uplink may have dropped.
        if (this.client.isOpen()) this.onStaleConnection?.();
        reject(new Error(`timed out waiting for ${label} response`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
      // sendData is async only when E2E crypto is active.
      void Promise.resolve(this.client.sendData(envelope)).then((sent) => {
        if (!sent) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(new Error(`cannot send ${label} request (socket closed)`));
        }
      });
    });
  }

  /** Drop all waiters and the frame subscription. */
  detach(): void {
    for (const [requestId, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("requester detached"));
      this.pending.delete(requestId);
    }
    this.detachFrame();
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    if (!requestId || !String(frame.type).endsWith(".result")) return;
    const waiter = this.pending.get(requestId);
    if (!waiter) return; // response to a timed-out request — ignore
    clearTimeout(waiter.timer);
    this.pending.delete(requestId);
    const error = frame.error as { code?: string; message?: string } | undefined;
    if (error) waiter.reject(new Error(`${error.code ?? "ERROR"}: ${error.message ?? "request failed"}`));
    else waiter.resolve(frame.payload);
  }
}
