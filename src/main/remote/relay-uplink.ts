/**
 * Mobile cloud relay uplink (docs/MOBILE-DESIGN.md §5, stage S1).
 *
 * Keeps a persistent WSS connection from the Windows host to the self-hosted
 * relay. Application frames are protocol v1 envelopes forwarded unchanged:
 *   - inbound data frame {from:"<deviceId>", ...envelope} → RemoteHost.handleTransportFrame
 *   - outbound envelope  → {to:"<deviceId>", ...envelope} on the socket
 * Control frames (plaintext) implement pairing ticket registration, device
 * token registration and revocation. The relay never sees plaintext content;
 * E2E encryption of data frames lands in S3.
 *
 * Daemon semantics: unlike WebRTC signaling there is no retry cap — the uplink
 * keeps reconnecting with exponential backoff while enabled (tray-resident =
 * Qoder daemon equivalent).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import type { RemoteHost, RelayOutbound } from "./host";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
/** Control frames the relay itself consumes (never forwarded to the host). */
const CONTROL_TYPES = new Set(["relay.ok", "relay.error", "offline", "pair.request", "device.online"]);

export type RelayUplinkState = "disabled" | "connecting" | "connected" | "error";

export interface RelayUplinkStatus {
  state: RelayUplinkState;
  relayUrl: string;
  lastError: string | null;
}

export interface RelayUplinkOptions {
  relayUrl: string;
  hostId: string;
  /** userData dir — device tokens persist in remote-relay-tokens.json. */
  userDataDir: string;
  getHost: () => RemoteHost | null;
  onStateChange?: (status: RelayUplinkStatus) => void;
}

export class RelayUplink implements RelayOutbound {
  private ws: WebSocket | null = null;
  private state: RelayUplinkState = "disabled";
  private lastError: string | null = null;
  private retryCount = 0;
  private stopped = true;
  /** deviceId → relay connection id (relay-<b64url>). */
  private readonly deviceToConnection = new Map<string, string>();
  /** In-memory mirror of the token file. */
  private tokens: Record<string, string> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatAlive = true;

  constructor(private readonly options: RelayUplinkOptions) {}

  // --- lifecycle -------------------------------------------------------------

  start(): void {
    if (this.stopped && !this.options.relayUrl) return;
    this.stopped = false;
    this.retryCount = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, "uplink stopped");
      } catch { /* ignore shutdown races */ }
    }
    this.setState("disabled", null);
  }

  /** Re-point the uplink at a new relay URL (config change). No-op when unchanged. */
  configure(relayUrl: string): void {
    if (relayUrl === this.options.relayUrl) return;
    this.options.relayUrl = relayUrl;
    const wasRunning = !this.stopped;
    this.stop();
    if (wasRunning && relayUrl) this.start();
  }

  getStatus(): RelayUplinkStatus {
    return { state: this.state, relayUrl: this.options.relayUrl, lastError: this.lastError };
  }

  // --- RelayOutbound -----------------------------------------------------------

  sendToDevice(deviceId: string, frame: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frame) as Record<string, unknown>;
    } catch {
      return; // host-side invariant; never forward garbage to the relay
    }
    this.observeOutbound(deviceId, parsed);
    if (!this.isOpen()) return; // dropped while offline — PWA resyncs via thread.resync on reconnect
    try {
      this.ws!.send(JSON.stringify({ ...parsed, to: deviceId }));
    } catch (error) {
      console.error("[relay-uplink] sendToDevice failed:", error);
    }
  }

  sendControl(frame: Record<string, unknown>): boolean {
    if (!this.isOpen()) return false;
    try {
      this.ws!.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      console.error("[relay-uplink] sendControl failed:", error);
      return false;
    }
  }

  deviceToken(deviceId: string): string | null {
    if (!deviceId) return null;
    const tokens = this.loadTokens();
    let token = tokens[deviceId];
    if (!token) {
      token = randomBytes(32).toString("base64url");
      tokens[deviceId] = token;
      this.saveTokens(tokens);
    }
    return token;
  }

  notifyRevoked(deviceId: string): void {
    this.deviceToConnection.delete(deviceId);
    const tokens = this.loadTokens();
    if (tokens[deviceId]) {
      delete tokens[deviceId];
      this.saveTokens(tokens);
    }
    // Ask the relay to drop its route and kick the device socket (4002).
    this.sendControl({ type: "device.revoke", deviceId });
  }

  // --- connection ---------------------------------------------------------------

  private connect(): void {
    if (this.stopped || !this.options.relayUrl) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setState("connecting", null);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.relayUrl);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setState("error", this.lastError);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      // A stable connection gives the next interruption a fresh retry budget.
      this.retryCount = 0;
      this.setState("connected", null);
      try {
        ws.send(JSON.stringify({ type: "host.register", hostId: this.options.hostId }));
      } catch { /* ignore */ }
      // Re-register device tokens so `hello` re-auth works after a relay restart.
      for (const [deviceId, token] of Object.entries(this.loadTokens())) {
        this.sendControl({ type: "pair.approved", deviceId, deviceToken: token });
      }
      this.startHeartbeat(ws);
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      let msg: Record<string, unknown> | null = null;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch { /* non-JSON frame — ignore */ }
      if (!msg || typeof msg !== "object") return;
      const type = typeof msg.type === "string" ? msg.type : "";
      if (type === "relay.error") {
        this.lastError = typeof msg.code === "string" ? String(msg.code) : "relay error";
        return;
      }
      if (CONTROL_TYPES.has(type)) {
        this.handleControl(msg);
        return;
      }
      // Data frame from a device socket: the relay tags it with `from`.
      const from = typeof msg.from === "string" ? msg.from : "";
      const connectionId = from ? this.deviceToConnection.get(from) : undefined;
      if (!connectionId) {
        console.warn(`[relay-uplink] dropping frame from unknown device ${from || "?"}`);
        return;
      }
      void this.options.getHost()?.handleTransportFrame(connectionId, raw).catch((error) => {
        console.error("[relay-uplink] handleTransportFrame failed:", error);
      });
    });

    ws.on("error", (error: Error & { message?: string }) => {
      if (this.ws === ws) this.lastError = error?.message || "uplink connection error";
    });

    ws.on("close", () => {
      const isCurrent = this.ws === ws;
      if (isCurrent) {
        this.ws = null;
        this.clearHeartbeat();
      }
      if (!isCurrent || this.stopped) return;
      this.setState(this.lastError ? "error" : "connecting", this.lastError);
      this.scheduleRetry();
    });
  }

  private handleControl(msg: Record<string, unknown>): void {
    const host = this.options.getHost();
    switch (msg.type) {
      case "pair.request": {
        // New pairing attempt routed by ticket. The relay already validated
        // the ticket; we only create the connection and issue a challenge.
        const deviceId = typeof msg.deviceId === "string" ? msg.deviceId : "";
        if (!deviceId || !host) return;
        const previous = this.deviceToConnection.get(deviceId);
        if (previous) host.transportClosed(previous, "relay-device-replaced");
        const connectionId = `relay-${randomBytes(10).toString("base64url")}`;
        this.deviceToConnection.set(deviceId, connectionId);
        host.transportOpened(connectionId, undefined, deviceId);
        return;
      }
      case "device.online": {
        // A stored-token hello succeeded on the relay: (re)issue a challenge so
        // the PWA can redo the signature handshake. Resetting first mirrors
        // WebRTC semantics where every new channel is a fresh session.
        const deviceId = typeof msg.deviceId === "string" ? msg.deviceId : "";
        if (!deviceId || !host) return;
        let connectionId = this.deviceToConnection.get(deviceId);
        if (connectionId) host.transportClosed(connectionId, "relay-device-replaced");
        else connectionId = `relay-${randomBytes(10).toString("base64url")}`;
        this.deviceToConnection.set(deviceId, connectionId);
        host.transportOpened(connectionId, undefined, deviceId);
        return;
      }
      case "offline": {
        if (msg.who !== "device") return; // host-side offline is meaningless for us
        const deviceId = typeof msg.deviceId === "string" ? msg.deviceId : "";
        const connectionId = deviceId ? this.deviceToConnection.get(deviceId) : undefined;
        if (!connectionId || !host) return;
        this.deviceToConnection.delete(deviceId);
        // Reason outside isReconnectFailure: the uplink itself stays connected,
        // so no signaling re-enable — the device will hello again when it returns.
        host.transportClosed(connectionId, "relay-device-offline");
        return;
      }
      default:
        return; // relay.ok and friends need no action
    }
  }

  /** pair.accepted frames carry the stable deviceToken — register it with the
   * relay so `hello` re-auth works (idempotent after a relay restart too). */
  private observeOutbound(deviceId: string, frame: Record<string, unknown>): void {
    if (frame.type !== "pair.accepted") return;
    const payload = (frame.payload || {}) as Record<string, unknown>;
    const acceptedDevice = typeof payload.deviceId === "string" ? payload.deviceId : deviceId;
    const token = this.deviceToken(acceptedDevice);
    if (token) this.sendControl({ type: "pair.approved", deviceId: acceptedDevice, deviceToken: token });
  }

  // --- retry / heartbeat -----------------------------------------------------------

  private scheduleRetry(): void {
    this.clearRetry();
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retryCount, RETRY_MAX_MS);
    this.retryCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeatAlive = true;
    ws.on("pong", () => {
      if (this.ws === ws) this.heartbeatAlive = true;
    });
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat();
        return;
      }
      if (!this.heartbeatAlive) {
        try {
          ws.terminate(); // close handler schedules the retry
        } catch { /* ignore */ }
        return;
      }
      this.heartbeatAlive = false;
      try {
        ws.ping();
      } catch {
        try {
          ws.close(1001, "uplink heartbeat failed");
        } catch { /* ignore */ }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatAlive = true;
  }

  // --- token store --------------------------------------------------------------------

  private tokenFile(): string {
    return join(this.options.userDataDir, "remote-relay-tokens.json");
  }

  private loadTokens(): Record<string, string> {
    if (this.tokens) return this.tokens;
    try {
      const parsed = JSON.parse(readFileSync(this.tokenFile(), "utf8")) as unknown;
      this.tokens = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
      this.tokens = {};
    }
    return this.tokens;
  }

  private saveTokens(tokens: Record<string, string>): void {
    this.tokens = tokens;
    try {
      mkdirSync(this.options.userDataDir, { recursive: true });
      writeFileSync(this.tokenFile(), JSON.stringify(tokens, null, 2), "utf8");
    } catch (error) {
      console.error("[relay-uplink] failed to persist device tokens:", error);
    }
  }

  // --- helpers ------------------------------------------------------------------------

  private isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private setState(state: RelayUplinkState, lastError: string | null): void {
    if (state === this.state && lastError === this.lastError) return;
    this.state = state;
    this.lastError = lastError;
    try {
      this.options.onStateChange?.(this.getStatus());
    } catch { /* listener must never break the uplink */ }
  }
}
