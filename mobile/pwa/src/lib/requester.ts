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
  /** S8.7: instance id for diagnostics (detects duplicate RelayClients). */
  getClientId?(): string;
}

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RequesterOptions {
  requestTimeoutMs?: number;
  onStaleConnection?: () => void;
  /**
   * Attached to every envelope. The host's RemoteService reads threadId from the
   * ENVELOPE (requiredThread), not the payload — per-thread requesters must set this.
   */
  threadId?: string;
}

/** S8.7 diagnostic hooks — the ?dbg=1 overlay registers here to trace request
 * correlation on a real device (sent / removed / unmatched, with instance label). */
type DbgEvent = { kind: "sent" | "removed" | "unmatched"; label: string; type?: string; requestId?: string; reason?: string; pending?: number };
interface DbgHooks { dbg?: (event: DbgEvent) => void }
declare global {
  interface Window { __mpi_dbg?: DbgHooks }
}
function dbg(event: Omit<DbgEvent, "label"> & { label: string }): void {
  try {
    const hooks = (globalThis as unknown as { __mpi_dbg?: DbgHooks }).__mpi_dbg;
    hooks?.dbg?.(event);
  } catch { /* diagnostics must never break the app */ }
}

export class Requester {
  private readonly pending = new Map<string, Waiter>();
  private reqCounter = 0;
  private readonly sessionId: string;
  private readonly detachFrame: () => void;
  /** S8.7: human-readable instance identity for the dbg overlay. */
  private readonly label: string;
  private isDetached = false;

  constructor(
    private readonly client: RequestTransport,
    options: RequesterOptions = {},
  ) {
    const rand = new Uint8Array(8);
    crypto.getRandomValues(rand);
    let hex = "";
    for (const byte of rand) hex += byte.toString(16).padStart(2, "0");
    this.sessionId = `pwa-${hex}`;
    const cid = client.getClientId?.() ?? "?";
    this.label = `${options.threadId ? `thread:${options.threadId.slice(0, 8)}` : `home:${this.sessionId.slice(-4)}`}@${cid}`;
    this.onStaleConnection = options.onStaleConnection;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.threadId = options.threadId;
    // Subscribe before any traffic can flow (RelayClient does not buffer frames).
    this.detachFrame = client.onFrame((frame) => this.handleFrame(frame));
  }

  private readonly requestTimeoutMs: number;
  private readonly onStaleConnection?: () => void;
  private readonly threadId?: string;

  /** Resolve with the response payload; reject on error envelope / timeout / send failure.
   * `timeoutMs` overrides the default for slow responses (e.g. multi-MB snapshots). */
  request<T>(type: string, payload?: unknown, label = type, timeoutMs?: number): Promise<T> {
    const requestId = `req-${++this.reqCounter}-${Math.random().toString(36).slice(2, 8)}`;
    const extra: { requestId: string; threadId?: string } = { requestId };
    if (this.threadId) extra.threadId = this.threadId;
    if (this.isDetached) {
      // S8.7 smoking gun: a request on an already-detached requester can never be
      // answered (its frame listener is gone) — the UI hangs until timeout.
      dbg({ kind: "removed", label: this.label, type, requestId, reason: "REQUEST-AFTER-DETACH" });
    }
    const envelope = makeEnvelope(type, this.sessionId, payload === undefined ? undefined : (payload as never), extra);
    dbg({ kind: "sent", label: this.label, type, requestId });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        dbg({ kind: "removed", label: this.label, type, requestId, reason: "timeout" });
        // Socket still open but the host never answered — its uplink may have dropped.
        if (this.client.isOpen()) this.onStaleConnection?.();
        reject(new Error(`timed out waiting for ${label} response`));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
      // sendData is async only when E2E crypto is active. A false result means
      // the frame could not go out at all — socket closed OR E2E handshake not
      // finished yet; either way the next (re)auth cycle retries.
      void Promise.resolve(this.client.sendData(envelope)).then((sent) => {
        if (!sent) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          dbg({ kind: "removed", label: this.label, type, requestId, reason: "send-failed" });
          reject(new Error(`cannot send ${label} request (connection not ready)`));
        }
      });
    });
  }

  /** Drop all waiters and the frame subscription. */
  detach(): void {
    if (this.isDetached) return;
    this.isDetached = true;
    dbg({ kind: "removed", label: this.label, requestId: "*", reason: `detach pending=${this.pending.size}` });
    for (const [requestId, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("requester detached"));
      this.pending.delete(requestId);
      dbg({ kind: "removed", label: this.label, requestId, reason: "detach" });
    }
    this.detachFrame();
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    if (!requestId || !String(frame.type).endsWith(".result")) return;
    const waiter = this.pending.get(requestId);
    if (!waiter) {
      // S8.7 diagnostic: a .result arrived for an unknown requestId — surface it
      // to the ?dbg=1 overlay instead of failing silently (real-device hang).
      dbg({ kind: "unmatched", label: this.label, type: String(frame.type), requestId, pending: this.pending.size });
      return; // response to a timed-out request — ignore
    }
    clearTimeout(waiter.timer);
    this.pending.delete(requestId);
    const error = frame.error as { code?: string; message?: string } | undefined;
    if (error) waiter.reject(new Error(`${error.code ?? "ERROR"}: ${error.message ?? "request failed"}`));
    else waiter.resolve(frame.payload);
  }
}
