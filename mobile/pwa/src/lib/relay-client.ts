/**
 * Minimal WSS client for the MPI cloud relay (docs/MOBILE-DESIGN.md §6).
 * Runs on browser and Node ≥24 native WebSocket alike — no `ws` dependency.
 *
 * Frame rules (see mobile/relay README): control frames {hello | pair.request}
 * decide the socket role; afterwards data frames are protocol v1 envelopes,
 * forwarded opaquely by the relay (which adds `from` on inbound).
 */

export type RelayClientState = "idle" | "connecting" | "open" | "closed";

type FrameListener = (frame: Record<string, unknown>) => void;

export interface RelayClientOptions {
  /** wss://host/ws — the relay endpoint. */
  url: string;
  onFrame?: FrameListener;
  onStateChange?: (state: RelayClientState, lastError: string | null) => void;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class RelayClient {
  private ws: WebSocket | null = null;
  private state: RelayClientState = "idle";
  private lastError: string | null = null;
  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** When set, the client keeps itself alive (auto-reconnect + re-hello). */
  private stayAlive = false;
  private helloCreds: { deviceId: string; deviceToken: string } | null = null;
  private readonly listeners = new Set<FrameListener>();

  constructor(private readonly options: RelayClientOptions) {}

  getState(): RelayClientState {
    return this.state;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /** Subscribe to every inbound frame (control + data). Returns unsubscribe. */
  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    if (this.state === "connecting" || this.state === "open") return;
    this.stayAlive = true;
    this.openSocket();
  }

  /** Permanent shutdown — no further reconnects. */
  close(code = 1000, reason = ""): void {
    this.stayAlive = false;
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(code, reason);
      } catch { /* already closed */ }
    }
    this.setState("closed", null);
  }

  /** True when the socket is open and can accept sends. */
  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(obj: unknown): boolean {
    if (!this.isOpen()) return false;
    try {
      this.ws!.send(JSON.stringify(obj));
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  // --- control frames -----------------------------------------------------------

  /** Store credentials used for re-auth on (re)connect; sent automatically on open. */
  setHelloCreds(deviceId: string, deviceToken: string): void {
    this.helloCreds = { deviceId, deviceToken };
  }

  /** Re-authenticate with a stored token now (and keep it for future reconnects). */
  hello(deviceId: string, deviceToken: string): boolean {
    this.setHelloCreds(deviceId, deviceToken);
    return this.send({ type: "hello", deviceId, deviceToken });
  }

  /** Start pairing with a fresh ticket (first frame of the socket). */
  pairRequest(ticket: string, deviceId: string, name: string): boolean {
    return this.send({ type: "pair.request", ticket, deviceId, name });
  }

  // --- internals ------------------------------------------------------------------

  private openSocket(): void {
    if (this.state === "connecting" || this.state === "open") return;
    this.setState("connecting", null);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.url);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setState("closed", this.lastError);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      // A stable connection gives the next interruption a fresh retry budget.
      this.retryCount = 0;
      this.setState("open", null);
      if (this.helloCreds) this.hello(this.helloCreds.deviceId, this.helloCreds.deviceToken);
    };

    ws.onmessage = (event: MessageEvent) => {
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!parsed || typeof parsed !== "object") return;
        frame = parsed as Record<string, unknown>;
      } catch {
        return; // non-JSON — ignore
      }
      this.options.onFrame?.(frame);
      for (const listener of [...this.listeners]) listener(frame);
    };

    ws.onerror = () => {
      if (!this.lastError) this.lastError = "relay connection error";
    };

    ws.onclose = () => {
      const isCurrent = this.ws === ws;
      if (isCurrent) this.ws = null;
      if (!isCurrent || !this.stayAlive) return;
      // Unexpected drop: back off and reconnect (daemon-style, no retry cap).
      this.setState("connecting", this.lastError);
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.retryCount, RECONNECT_MAX_MS);
      this.retryCount += 1;
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.stayAlive) this.openSocket();
      }, delay);
    };
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setState(state: RelayClientState, lastError: string | null): void {
    if (state === this.state && lastError === this.lastError) return;
    this.state = state;
    this.lastError = lastError;
    try {
      this.options.onStateChange?.(state, lastError);
    } catch { /* listener must never break the client */ }
  }
}

/** Wait for the first frame matching `pred`; rejects after timeout. */
export function waitForFrame(client: RelayClient, pred: (frame: Record<string, unknown>) => boolean, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const off = client.onFrame((frame) => {
      if (pred(frame)) {
        cleanup();
        resolve(frame);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for relay frame`));
    }, timeoutMs);
    function cleanup() {
      off();
      clearTimeout(timer);
    }
  });
}
