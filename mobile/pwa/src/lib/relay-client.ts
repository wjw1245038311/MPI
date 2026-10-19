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
  /**
   * 二进制帧（2026-09-30，去 base64 的 33% 膨胀）：两端都声明了 `e2e-bin` 时为 true。
   * 为 true 时发送走 [encryptBinary]、入站二进制消息走 [decryptBinary]，JSON 两条路仍保留作兼容。
   */
  binary?: boolean;
  /** 明文 envelope JSON → 完整的 WebSocket 二进制消息（含路由头部）。 */
  encryptBinary?(plaintextJson: string): Promise<Uint8Array>;
  /** 二进制消息 → 明文 envelope JSON（throws on tamper / 格式不对）。 */
  decryptBinary?(bytes: Uint8Array): Promise<string>;
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
  /**
   * 前台死连接看门狗（2026-10-19）。
   *
   * 浏览器/笔记本冻结或休眠过后，socket 可能已经断了，而 `close` 事件**不一定派发**
   * （无头 Chrome 实测：冻结 120s 后 socket 已 closed，150s 内一个新连接都没建）。
   * 以前完全靠 `close` 事件排重连，没有事件就永远躺着——用户看到的就是「掉线/转圈」。
   * 这里每 5s 看一眼：前台、该连、没有 socket、也没在退避 → 直接重开一条。
   */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** 页面是否在后台（在后台不排重连；见 setBackgrounded）。 */
  private backgrounded = false;
  /** When set, the client keeps itself alive (auto-reconnect + re-hello). */
  private stayAlive = false;
  private helloCreds: { deviceId: string; deviceToken: string; hostId?: string } | null = null;
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
    this.startWatchdog();
    this.openSocket();
  }

  /**
   * 立即重连（回到前台 / 网络恢复时调）。
   *
   * 为什么要它：后台标签页会被浏览器节流甚至冻结，退避定时器不一定按时跑；等它自己
   * 轮到可能要等很久，用户看到的就是「挂久了只能重开页面」。这里清掉退避、马上再试；
   * socket 半死（浏览器不一定及时报 onclose）就先丢掉。
   */
  reconnectNow(): void {
    if (!this.stayAlive) return;
    // E2E 通道已就绪 = 真连着，别去动它
    if (this.frameCrypto && this.isOpen()) return;
    this.retryCount = 0;
    this.clearReconnectTimer();
    const socket = this.ws;
    if (socket) {
      this.ws = null;
      try {
        socket.close(1000, "kick");
      } catch {
        /* already closed */
      }
    }
    this.openSocket();
  }

  /** Permanent shutdown — no further reconnects. */
  close(code = 1000, reason = ""): void {
    this.stayAlive = false;
    this.clearReconnectTimer();
    this.stopWatchdog();
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
        // 协商了二进制就走二进制（同样一把密钥，只是不套 base64）；否则 JSON（老端兼容）。
        if (this.frameCrypto.binary && this.frameCrypto.encryptBinary) {
          return this.sendRawBinary(await this.frameCrypto.encryptBinary(JSON.stringify(obj)));
        }
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

  /** 发送一条二进制帧（E2E 数据帧的紧凑编码，去 base64 的 33% 膨胀）。 */
  private sendRawBinary(bytes: Uint8Array): boolean {
    if (!this.isOpen()) return false;
    try {
      this.ws!.send(bytes);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  // --- control frames -----------------------------------------------------------

  /** Store credentials used for re-auth on (re)connect; sent automatically on open.
   * hostId routes the hello to this host's record — one phone can be paired with
   * several desktops, each holding its own token (relay keys by host+device). */
  setHelloCreds(deviceId: string, deviceToken: string, hostId?: string): void {
    this.helloCreds = { deviceId, deviceToken, hostId };
  }

  /** Re-authenticate with a stored token now (and keep it for future reconnects). */
  hello(deviceId: string, deviceToken: string, hostId?: string): boolean {
    this.setHelloCreds(deviceId, deviceToken, hostId);
    return this.send({ type: "hello", deviceId, deviceToken, ...(hostId ? { hostId } : {}) });
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
      // 二进制帧要拿到 ArrayBuffer（不是 Blob）——否则要先 await blob.arrayBuffer()，多一次异步。
      ws.binaryType = "arraybuffer";
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
      // 二进制消息 = 协商后的 E2E 数据帧；解出明文后再走与 JSON 帧一样的派发。
      if (event.data instanceof ArrayBuffer) {
        const crypto = this.frameCrypto;
        if (!crypto?.decryptBinary) {
          console.warn("[relay-client] binary frame without binary crypto — dropped");
          return;
        }
        void crypto
          .decryptBinary(new Uint8Array(event.data))
          .then((plaintext) => {
            const parsed: unknown = JSON.parse(plaintext);
            if (!parsed || typeof parsed !== "object") return;
            this.options.onFrame?.(parsed as Record<string, unknown>);
            for (const listener of [...this.listeners]) listener(parsed as Record<string, unknown>);
          })
          .catch((error) => console.error("[relay-client] binary E2E decrypt failed:", error));
        return;
      }
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
      if (frame.type === "revoked") {
        // **主机把本设备撤销了**（`device.revoke` → relay 回 `revoked` + close 4002）。
        // 这时令牌已从主机与中继两侧删掉：继续重连只会每轮都收到 4001 AUTH_FAILED，
        // 用户在界面上看到的就是「重新连接中…」无限转圈（2026-10-19 真机取证）。
        // 停掉重连，把状态交给 UI 显示「此设备已被桌面端撤销，请重新配对」。
        this.stayAlive = false;
        this.clearReconnectTimer();
        this.setState("closed", "REVOKED");
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
      // 4002 = REVOKED（主机撤销了本设备）。令牌两边都没了，重连必被 4001 拒——直接停。
      // 中继可能来不及发 `revoked` 帧就断开，所以要靠关闭码兜底。
      if (code === 4002 && this.lastError !== "REPLACED") {
        this.stayAlive = false;
        this.clearReconnectTimer();
        this.setState("closed", "REVOKED");
        return;
      }
      if (code !== undefined && code !== 1000 && this.lastError !== "REPLACED") {
        this.lastError = `closed ${code}${reason ? ` "${reason}"` : ""}`;
      }
      if (!isCurrent || !this.stayAlive) return;
      // 后台期间不排重连：等回到前台由 App 整条重来（省无线电唤醒；后台靠 WebPush 通知）。
      if (this.backgrounded) {
        this.setState("closed", this.lastError);
        return;
      }
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

  /**
   * **页面在后台时不要主动重连**（2026-10-16，用户口径：后台断了就先别管，打开会话再连）。
   *
   * 理由：移动端浏览器在后台本来就会冻结定时器/挂起连接，主动重连只会白耗**无线电唤醒**；
   * 后台期间需要的"有事找你"由 WebPush 承担（S7）——点通知回到前台即可。
   * 回前台时调用 `setBackgrounded(false)`，若还没连上就立刻续一次（App 侧还会整条走
   * `startSession`，顺带重算候选 = 择优）。
   */
  setBackgrounded(value: boolean): void {
    if (this.backgrounded === value) return;
    this.backgrounded = value;
    if (value) {
      this.clearReconnectTimer();
      return;
    }
    if (this.stayAlive && !this.isOpen()) this.openSocket();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.checkAlive(), 5_000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /** 看门狗本体：只处理「该连、前台、既没 socket 也没在退避」这个死局。 */
  private checkAlive(): void {
    if (!this.stayAlive || this.backgrounded) return;
    const socket = this.ws;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    if (this.reconnectTimer) return; // close 事件已经排好了退避
    this.retryCount = 0; // 自愈不背之前的退避惩罚
    this.setState("connecting", this.lastError);
    this.openSocket();
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
