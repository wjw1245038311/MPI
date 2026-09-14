/**
 * Host session layer for the PWA home view (S4, docs/MOBILE-DESIGN.md §6.2 item 2).
 *
 * Owns projects/threads list caching over a Requester (requestId correlation),
 * tracks host online state, and polls threads.list while any cached thread is
 * running (§9 S4/S5). Pure logic — node-testable against a real relay + fake
 * host service.
 */
import type { RemoteProject, RemoteThreadSummary } from "../../../shared/protocol";
import type { RelayClient } from "./relay-client";
import { Requester } from "./requester";

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
  private readonly requester: Requester;
  private readonly client: RelayClient;
  private readonly pollIntervalMs: number;

  private snapshot: SessionSnapshot;
  private readonly listeners = new Set<Listener>();
  private refreshing = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly detachFrame: () => void;
  private readonly detachState: () => void;

  constructor(client: RelayClient, options: HostSessionOptions = {}) {
    // S8.7 diagnostic: who creates a second HostSession? (real-device hang)
    try {
      const hooks = (globalThis as unknown as { __mpi_dbg?: { dbg?: (e: Record<string, unknown>) => void } }).__mpi_dbg;
      hooks?.dbg?.({ kind: "removed", label: `app@${client.getClientId()}`, requestId: "*", reason: `HostSession CREATED stack=${new Error("hs").stack?.split("\n").slice(2, 5).join(" <- ") ?? "?"}` });
    } catch { /* diagnostics must never break the app */ }
    this.client = client;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.requester = new Requester(client, {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      onStaleConnection: options.onStaleConnection,
    });

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
    this.detachFrame = client.onFrame(() => {
      // Per-frame update is fine at S4 cadence; throttle here if S5 streaming gets hot.
      this.update({ lastFrameAt: Date.now() });
    });
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
      const projectsPayload = await this.requester.request<{ projects?: RemoteProject[] }>("projects.list", undefined, "projects");
      const projects = Array.isArray(projectsPayload?.projects) ? projectsPayload.projects : [];
      const threadsByProject: Record<string, RemoteThreadSummary[]> = {};
      await Promise.all(
        projects.map(async (project) => {
          try {
            const payload = await this.requester.request<{ threads?: RemoteThreadSummary[] }>("threads.list", { projectId: project.id }, "threads");
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
    this.requester.detach();
    this.detachFrame();
    this.detachState();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.listeners.clear();
  }

  // --- internals -----------------------------------------------------------------

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
