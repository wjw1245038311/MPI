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

/** E2E frame crypto hook — set after pair.accepted delivers the host's X25519 pub. */
export interface FrameCrypto {
  /** Plaintext envelope JSON → {e,n,c} object ready to send. */
  encrypt(plaintextJson: string): Promise<Record<string, unknown>>;
  /** {e,n,c} frame → plaintext envelope JSON (throws on tamper). */
  decrypt(frame: Record<string, unknown>): Promise<string>;
}

export interface RelayClientOptions {
  /** wss://host/ws — the relay endpoint. */
  url: string;
  onFrame?: FrameListener;
  onStateChange?: (state: RelayClientState, lastError: string | null) => void;
  /** Observes every raw JSON string sent on the wire (tests/debug). */
  onSend?: (rawJson: string) => void;
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
  private frameCrypto: FrameCrypto | null = null;
  private readonly listeners = new Set<FrameListener>();
  private readonly stateListeners = new Set<(state: RelayClientState, lastError: string | null) => void>();
  /** S8.7: short instance id for the dbg overlay (detects duplicate clients). */
  private readonly clientId = "c" + Math.random().toString(36).slice(2, 6);

  constructor(private readonly options: RelayClientOptions) {}

  getClientId(): string {
    return this.clientId;
  }

  getState(): RelayClientState {
    return this.state;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /** Subscribe to every inbound frame (control + data). Returns unsubscribe.
   * NOTE: subscribe before connect() — frames are not buffered for late listeners. */
  onFrame(listener: FrameListener): () => void {
    // S8.7 diagnostic: trace listener add/remove (real-device hang). Gated — no
    // stack allocation unless the ?dbg=1 overlay is registered.
    const dbgHooksAdd = (globalThis as unknown as { __mpi_dbg?: { dbg?: (e: Record<string, unknown>) => void } }).__mpi_dbg;
    if (dbgHooksAdd) {
      try {
        dbgHooksAdd.dbg?.({ kind: "removed", label: `client@${this.clientId}`, requestId: "*", reason: `onFrame ADD total=${this.listeners.size + 1} stack=${new Error("of").stack?.split("\n").slice(2, 4).join(" <- ") ?? "?"}` });
      } catch { /* diagnostics must never break the client */ }
    }
    this.listeners.add(listener);
    return () => {
      const dbgHooksRm = (globalThis as unknown as { __mpi_dbg?: { dbg?: (e: Record<string, unknown>) => void } }).__mpi_dbg;
      if (dbgHooksRm) {
        try {
          dbgHooksRm.dbg?.({ kind: "removed", label: `client@${this.clientId}`, requestId: "*", reason: `onFrame REMOVE total=${Math.max(0, this.listeners.size - 1)} stack=${new Error("of").stack?.split("\n").slice(2, 4).join(" <- ") ?? "?"}` });
        } catch { /* diagnostics must never break the client */ }
      }
      return this.listeners.delete(listener);
    };
  }

  /** Subscribe to connection state changes (in addition to the constructor option). */
  onState(listener: (state: RelayClientState, lastError: string | null) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
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

  /** Test/manual helper: drop the socket as if the network died — auto-reconnect
   * (and re-hello) still apply, unlike close() which is a permanent shutdown.
   * (Node's native WebSocket has no terminate(); 1006 is reserved so use 1000.) */
  simulateDrop(): void {
    try {
      this.ws?.close(1000, "simulate drop");
    } catch { /* already gone */ }
  }

  send(obj: unknown): boolean {
    return this.sendRaw(JSON.stringify(obj));
  }

  /** Send a protocol v1 envelope, E2E-encrypted when a session is active.
   * Control frames (hello/pair.request) always go through plain send().
   * Data frames are NEVER sent plaintext: before the handshake installs the
   * crypto they would be dropped by the host — fail fast instead so the UI
   * retries as soon as re-auth completes (a 10s timeout per request is worse). */
  async sendData(obj: unknown): Promise<boolean> {
    const record = obj as Record<string, unknown>;
    if (record.v === 1 && !this.frameCrypto) {
      this.lastError = "E2E session not ready";
      return false;
    }
    if (this.frameCrypto && record.v === 1) {
      try {
        return this.sendRaw(JSON.stringify(await this.frameCrypto.encrypt(JSON.stringify(obj))));
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        return false;
      }
    }
    return this.send(obj);
  }

  /** Install/clear the E2E session crypto. Inbound {e,n,c} frames are decrypted
   * and dispatched as their plaintext envelope; without crypto they are dropped. */
  setFrameCrypto(crypto: FrameCrypto | null): void {
    this.frameCrypto = crypto;
    if (crypto) this.wakeReadyWaiters();
  }

  private readyWaiters = new Set<() => void>();

  /** Resolves once data frames can flow: socket open AND E2E crypto installed.
   * Fresh page loads (deep links) race the hello/challenge handshake — callers
   * that send v1 envelopes must await this first. */
  whenReady(timeoutMs = 15_000): Promise<void> {
    if (this.frameCrypto && this.isOpen()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wake = () => {
        if (this.frameCrypto && this.isOpen()) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for E2E session"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.readyWaiters.delete(wake);
      };
      this.readyWaiters.add(wake);
    });
  }

  private wakeReadyWaiters(): void {
    for (const wake of [...this.readyWaiters]) wake();
  }

  private sendRaw(rawJson: string): boolean {
    if (!this.isOpen()) return false;
    try {
      this.ws!.send(rawJson);
      this.options.onSend?.(rawJson);
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
    // Guard on the live socket, not state: after a drop the close handler already
    // set state to "connecting" while scheduling the retry — a state guard here
    // would deadlock the reconnect (no socket exists yet).
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
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
      if (this.frameCrypto) this.wakeReadyWaiters();
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
      if (frame.type === "replaced") {
        // Another connection with the same identity took over this device slot.
        // Stop reconnecting: retrying would just ping-pong with the other client
        // (two tabs of the PWA on one phone). Surface it to the UI instead.
        this.stayAlive = false;
        this.clearReconnectTimer();
        this.setState("closed", "REPLACED");
        return;
      }
      void this.dispatch(frame);
    };

    ws.onerror = () => {
      if (!this.lastError) this.lastError = "relay connection error";
    };

    ws.onclose = (event?: CloseEvent) => {
      const isCurrent = this.ws === ws;
      if (isCurrent) this.ws = null;
      // Record WHY the socket died — 1006 = network/browser killed it (no close
      // frame), 4001 = auth failed (身份不再被认可), 4005 = heartbeat timeout,
      // 4006 = replaced by another connection.
      // ⚠ 关闭码只能从 CloseEvent 取：浏览器 WebSocket 实例上并没有 closeCode/
      // closeReason 属性（之前读实例属性 → 永远 undefined → 关闭码从未被记录，
      // 4001 这类「永不恢复」的错误因此只能表现为泛化报错）。
      // REPLACED（onmessage 里置的）更具体，不要覆盖它。
      const code = event?.code;
      const reason = event?.reason;
      if (code !== undefined && code !== 1000 && this.lastError !== "REPLACED") {
        this.lastError = `closed ${code}${reason ? ` "${reason}"` : ""}`;
      }
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

  /** Decrypt E2E frames (if a session is active), then fan out to listeners. */
  private async dispatch(frame: Record<string, unknown>): Promise<void> {
    if (frame.e === 1) {
      const crypto = this.frameCrypto;
      if (!crypto) {
        console.warn("[relay-client] encrypted frame without session crypto — dropped");
        return;
      }
      let plaintext: string;
      try {
        plaintext = await crypto.decrypt(frame);
      } catch (error) {
        console.error("[relay-client] E2E decrypt failed:", error);
        return;
      }
      const parsed: unknown = JSON.parse(plaintext);
      if (!parsed || typeof parsed !== "object") return;
      frame = parsed as Record<string, unknown>;
    }
    this.options.onFrame?.(frame);
    for (const listener of [...this.listeners]) listener(frame);
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
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state, lastError);
      } catch { /* listeners must never break the client */ }
    }
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
