/**
 * Host session layer for the PWA home view (S4, docs/MOBILE-DESIGN.md §6.2 item 2).
 *
 * Owns request/response correlation over RelayClient (requestId routing on
 * "<type>.result" envelopes), caches projects/threads lists, tracks host online
 * state, and polls threads.list while any cached thread is running (§9 S4/S5).
 * Pure logic — node-testable against a real relay + fake host service.
 */
import { makeEnvelope } from "../../../shared/protocol";
import type { RemoteProject, RemoteThreadSummary } from "../../../shared/protocol";
import type { RelayClient } from "./relay-client";

export interface SessionSnapshot {
  /** Socket open — the host is reachable through the relay (not necessarily authenticated). */
  hostOnline: boolean;
  /** Last inbound frame of any kind (host or relay control) — "last seen" for UI. */
  lastFrameAt: number | null;
  projects: RemoteProject[];
  threadsByProject: Record<string, RemoteThreadSummary[]>;
  loading: boolean;
  error: string | null;
}

export interface HostSessionOptions {
  /** Poll cadence while any cached thread is running (default 5s). */
  pollIntervalMs?: number;
  /** Per-request timeout (default 10s). */
  requestTimeoutMs?: number;
  /** Called when a request times out while the socket is still open — the host's
   * uplink may have dropped silently; App re-hellos to force re-routing. */
  onStaleConnection?: () => void;
}

type Listener = (snapshot: SessionSnapshot) => void;

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class HostSession {
  private readonly client: RelayClient;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onStaleConnection?: () => void;
  /** Stable per-socket session id — the host does not validate it against its own. */
  private readonly sessionId: string;

  private snapshot: SessionSnapshot;
  private readonly listeners = new Set<Listener>();
  /** requestId → waiter for the matching "<type>.result" envelope. */
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private reqCounter = 0;
  private refreshing = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly detachFrame: () => void;
  private readonly detachState: () => void;

  constructor(client: RelayClient, options: HostSessionOptions = {}) {
    this.client = client;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onStaleConnection = options.onStaleConnection;
    // "pwa-" + 8 random bytes — opaque to the host.
    const rand = new Uint8Array(8);
    crypto.getRandomValues(rand);
    let hex = "";
    for (const byte of rand) hex += byte.toString(16).padStart(2, "0");
    this.sessionId = `pwa-${hex}`;
    // Seed from the current socket state — no transition event fires for an already-open socket.
    this.snapshot = {
      hostOnline: client.getState() === "open",
      lastFrameAt: null,
      projects: [],
      threadsByProject: {},
      loading: false,
      error: null,
    };

    // Subscribe before any traffic can flow (RelayClient does not buffer frames).
    this.detachFrame = client.onFrame((frame) => this.handleFrame(frame));
    this.detachState = client.onState((state) => {
      const online = state === "open";
      if (online !== this.snapshot.hostOnline) this.update({ hostOnline: online });
      // Re-fetch after a reconnect so the lists reflect current host state.
      if (online && !this.refreshing) void this.refresh();
    });
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fetch projects.list + threads.list for every project. Safe to call repeatedly. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.update({ loading: true, error: null });
    try {
      const projectsPayload = await this.request<{ projects?: RemoteProject[] }>("projects.list", undefined, "projects");
      const projects = Array.isArray(projectsPayload?.projects) ? projectsPayload.projects : [];
      const threadsByProject: Record<string, RemoteThreadSummary[]> = {};
      await Promise.all(
        projects.map(async (project) => {
          try {
            const payload = await this.request<{ threads?: RemoteThreadSummary[] }>("threads.list", { projectId: project.id }, "threads");
            threadsByProject[project.id] = Array.isArray(payload?.threads) ? payload.threads : [];
          } catch {
            threadsByProject[project.id] = []; // keep the list usable; per-project error surfacing is out of scope for v1
          }
        }),
      );
      this.update({ projects, threadsByProject });
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.refreshing = false;
      this.schedulePoll();
    }
  }

  /** Tear down listeners and timers. */
  detach(): void {
    this.detachFrame();
    this.detachState();
    for (const [requestId, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("session detached"));
      this.pending.delete(requestId);
    }
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.listeners.clear();
  }

  // --- internals -----------------------------------------------------------------

  /** Correlated request: resolves with the response payload, rejects on error envelope/timeout. */
  private async request<T>(type: string, payload: unknown, label: string): Promise<T> {
    const requestId = `req-${++this.reqCounter}-${Math.random().toString(36).slice(2, 8)}`;
    const envelope = makeEnvelope(type, this.sessionId, payload === undefined ? undefined : (payload as never), { requestId });

    // Register the waiter BEFORE sending — on localhost the reply can land before
    // the async send path finishes, and RelayClient does not buffer frames.
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        // Socket still open but the host never answered — its uplink may have dropped.
        if (this.client.isOpen()) this.onStaleConnection?.();
        reject(new Error(`timed out waiting for ${label} response`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
      // sendData is async only when E2E crypto is active.
      void this.client.sendData(envelope).then((sent) => {
        if (!sent) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(new Error(`cannot send ${label} request (socket closed)`));
        }
      });
    });
  }

  private handleFrame(frame: Record<string, unknown>): void {
    // Per-frame update is fine at S4 cadence; throttle here if S5 streaming gets hot.
    this.update({ lastFrameAt: Date.now() });
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

  /** Poll while any cached thread is running; stop otherwise. */
  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const hasRunning = Object.values(this.snapshot.threadsByProject).some((threads) => threads.some((t) => t.state === "running"));
    if (!hasRunning || !this.client.isOpen()) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.refresh();
    }, this.pollIntervalMs);
  }

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot);
      } catch { /* listeners must never break the session */ }
    }
  }
}
