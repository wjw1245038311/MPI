#!/usr/bin/env node
/**
 * MPI mobile cloud relay (S0 prototype — plaintext skeleton).
 *
 * Design: docs/MOBILE-DESIGN.md §3/§4.3/§12.4. The relay is an opaque frame
 * router between Windows host uplinks and phone PWA sockets:
 *   - it never parses or decrypts application frames (protocol v1 envelopes,
 *     later {e,n,c} E2E ciphertext) — data frames are forwarded unchanged;
 *   - routing metadata visible to the relay: hostId / deviceId / online state;
 *   - control frames (plaintext JSON) share the socket with data frames and
 *     are distinguished by `type`.
 *
 * S7 adds WebPush: the host registers each device's PushSubscription
 * (push.subscribe control frame) and fires push.request metadata; the relay
 * signs/encrypts with its VAPID key (vapid.mjs, zero-dep node:crypto) and POSTs
 * to subscription.endpoint. The PWA service worker shows the notification.
 *
 * Frame rules:
 *   host  → relay : control {ticket.register|pair.approved|device.revoke|push.subscribe|push.request}
 *                   data    {to:"<deviceId>", ...opaque...}   (whole object forwarded)
 *   device→ relay : first frame {hello | pair.request}; afterwards opaque data
 *                   frames are forwarded to the bound host uplink.
 *
 * Env: RELAY_PORT (default 9001, 0 = ephemeral), RELAY_HOST (default 0.0.0.0),
 *      RELAY_PING_MS (default 20000), RELAY_DEAD_MS (default 60000),
 *      RELAY_VAPID_KEY_FILE (default <script dir>/data/vapid.json),
 *      RELAY_VAPID_SUB (JWT `sub` claim, default mailto:relay@mpi.local),
 *      RELAY_ALLOW_INSECURE_PUSH=1 permits http:// push endpoints (tests only).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { encryptWebPushPayload, loadOrCreateVapidKey, vapidAuthTag, vapidJwt } from "./vapid.mjs";

const PORT = Number(process.env.RELAY_PORT || 9001);
const HOST = process.env.RELAY_HOST || "0.0.0.0";
const PING_MS = Math.max(500, Number(process.env.RELAY_PING_MS || 20_000));
/** A socket that misses DEAD_MS/PING_MS consecutive pings is dead (default ~60s). */
const DEAD_MS = Math.max(PING_MS * 2, Number(process.env.RELAY_DEAD_MS || 60_000));
/** protocol v1 PAYLOAD_TOO_LARGE cap (defense in depth; the host enforces it too). */
const MAX_FRAME_BYTES = 2_000_000;

// --- WebPush (S7) ------------------------------------------------------------------
/** deviceId -> PushSubscription {endpoint, keys:{p256dh, auth}}. Volatile on
 * purpose: the host re-reports all subscriptions after a relay restart (same
 * pattern as device tokens). */
const pushSubs = new Map();
const VAPID_KEY_FILE = process.env.RELAY_VAPID_KEY_FILE || join(dirname(fileURLToPath(import.meta.url)), "data", "vapid.json");
const VAPID_SUB_CLAIM = process.env.RELAY_VAPID_SUB || "mailto:relay@mpi.local";
let vapidKey = null;
try {
  vapidKey = loadOrCreateVapidKey(VAPID_KEY_FILE);
} catch (error) {
  console.error("[relay] VAPID key unavailable — push disabled:", error.message);
}
const ALLOW_INSECURE_PUSH = process.env.RELAY_ALLOW_INSECURE_PUSH === "1";

function isPushSubscription(sub) {
  if (!sub || typeof sub !== "object") return false;
  if (typeof sub.endpoint !== "string" || !/^https?:\/\//.test(sub.endpoint)) return false;
  if (/^http:/.test(sub.endpoint) && !ALLOW_INSECURE_PUSH) return false; // SSRF guard
  const keys = sub.keys;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return false;
  try {
    const p256 = Buffer.from(keys.p256dh, "base64url");
    const auth = Buffer.from(keys.auth, "base64url");
    if (p256.length !== 65 || p256[0] !== 0x04) return false;
    if (auth.length !== 16) return false;
  } catch {
    return false;
  }
  return true;}

/** Sign + encrypt + POST one push. Fire-and-forget from the socket handler.
 * @returns {Promise<boolean>} delivered? */
async function deliverWebPush(deviceId, sub, frame) {
  const payload = JSON.stringify({
    kind: str(frame.kind, 32) || "approval",
    title: str(frame.title, 200),
    body: str(frame.body, 500),
    deepLink: str(frame.deepLink, 512),
  });
  const { body, cryptoKey, authKey } = encryptWebPushPayload(Buffer.from(payload, "utf8"), sub.keys.p256dh);
  const jwt = vapidJwt({ privPem: vapidKey.privPem, aud: new URL(sub.endpoint).origin, sub: VAPID_SUB_CLAIM });
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: `WebPush vapid="${jwt}" t="${vapidAuthTag(jwt, authKey)}"`,
      "crypto-key": cryptoKey,
      "content-encoding": "aes128gcm",
      ttl: "30",
      urgency: "high",
    },
    body,
  });
  if (res.status === 404 || res.status === 410) {
    pushSubs.delete(deviceId);
    log(`push subscription for ${deviceId} is dead (${res.status}) — removed`);
    return false;
  }
  return res.ok;
}

// --- close codes (application range) -------------------------------------------
const CLOSE_AUTH_FAILED = 4001;
const CLOSE_REVOKED = 4002;
const CLOSE_TOO_LARGE = 4003;
const CLOSE_BAD_FIRST_FRAME = 4004;
const CLOSE_HEARTBEAT_TIMEOUT = 4005;
const CLOSE_REPLACED = 4006;

// --- routing table ---------------------------------------------------------------
/** hostId -> { ws } */
const hosts = new Map();
/** deviceId -> { ws|null, hostId, token|null, status:"pending"|"approved", name } */
const devices = new Map();
/** ticket -> { hostId, expiresAt, used } (one-shot, 5 min default TTL). Expired
 * entries are kept until queried (so the phone gets TICKET_EXPIRED, not
 * TICKET_INVALID) and pruned lazily at registration time. */
const tickets = new Map();
const MAX_TICKETS = 1_000;

function log(...args) {
  console.log(new Date().toISOString(), "[relay]", ...args);
}

function isWsOpen(ws) {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function send(ws, obj) {
  if (!isWsOpen(ws)) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function tryClose(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch { /* already closed */
  }
}

function str(value, maxLen) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen ? value : "";
}

// --- lifecycle ---------------------------------------------------------------------
/** Remove a leaving socket from the routing table and notify its peer. */
function dropSocket(conn) {
  if (conn.role === "host") {
    const current = hosts.get(conn.id);
    if (current && current.ws === conn.ws) hosts.delete(conn.id);
    log(`host ${conn.id} gone`);
    for (const rec of devices.values()) {
      if (rec.hostId === conn.id && isWsOpen(rec.ws)) {
        send(rec.ws, { type: "offline", who: "host", hostId: conn.id });
      }
    }
  } else if (conn.role === "device") {
    const rec = devices.get(conn.id);
    log(`device ${conn.id} gone`);
    // Only the currently bound socket counts as an offline event; a replaced
    // (stale) socket closing must not notify the host.
    if (rec && rec.ws === conn.ws) {
      rec.ws = null; // keep token record for re-hello
      const host = hosts.get(rec.hostId);
      if (isWsOpen(host?.ws)) send(host.ws, { type: "offline", who: "device", deviceId: conn.id });
    }
  }
}

// --- host frames ---------------------------------------------------------------------
function handleHostFrame(conn, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return send(conn.ws, { type: "relay.error", code: "INVALID_JSON" });
  }
  if (!frame || typeof frame !== "object") return send(conn.ws, { type: "relay.error", code: "INVALID_REQUEST" });

  switch (frame.type) {
    case "ticket.register": {
      const ticket = str(frame.ticket, 128);
      const expiresAt = Number.isSafeInteger(frame.expiresAt) ? frame.expiresAt : Date.now() + 5 * 60_000;
      if (!ticket || expiresAt <= Date.now()) return send(conn.ws, { type: "relay.error", code: "INVALID_TICKET" });
      const now = Date.now();
      for (const [t, rec] of [...tickets]) {
        if (rec.expiresAt + 60_000 <= now) tickets.delete(t); // long-expired garbage
      }
      if (tickets.size >= MAX_TICKETS) return send(conn.ws, { type: "relay.error", code: "TICKET_TABLE_FULL" });
      tickets.set(ticket, { hostId: conn.id, expiresAt, used: false });
      return send(conn.ws, { type: "relay.ok", role: "host" });
    }

    case "pair.approved": {
      const deviceId = str(frame.deviceId, 128);
      const token = str(frame.deviceToken, 128);
      let rec = devices.get(deviceId);
      if (rec && rec.hostId !== conn.id) return send(conn.ws, { type: "relay.error", code: "UNKNOWN_DEVICE" });
      if (!token) return send(conn.ws, { type: "relay.error", code: "INVALID_TOKEN" });
      if (!rec) {
        // Token (re-)registration without a live pending pairing — e.g. the
        // uplink re-announces its stored tokens after a relay restart.
        rec = { ws: null, hostId: conn.id, token: null, status: "pending", name: deviceId };
        devices.set(deviceId, rec);
      }
      rec.token = token;
      rec.status = "approved";
      log(`device ${deviceId} approved on host ${conn.id}`);
      return send(conn.ws, { type: "relay.ok", role: "host", deviceId });
    }

    case "device.revoke": {
      const deviceId = str(frame.deviceId, 128);
      const rec = devices.get(deviceId);
      let removed = false;
      if (rec && rec.hostId === conn.id) {
        send(rec.ws, { type: "revoked" });
        tryClose(rec.ws, CLOSE_REVOKED, "REVOKED");
        devices.delete(deviceId);
        removed = true;
        log(`device ${deviceId} revoked by host ${conn.id}`);
      }
      return send(conn.ws, { type: "relay.ok", role: "host", removed });
    }

    case "push.subscribe": {
      const deviceId = str(frame.deviceId, 128);
      if (!deviceId || !isPushSubscription(frame.subscription)) {
        return send(conn.ws, { type: "relay.error", code: "INVALID_SUBSCRIPTION" });
      }
      pushSubs.set(deviceId, frame.subscription);
      log(`push subscription stored for ${deviceId}`);
      return send(conn.ws, { type: "relay.ok", role: "host", deviceId });
    }

    case "push.request": {
      const deviceId = str(frame.deviceId, 128);
      if (!deviceId) return send(conn.ws, { type: "relay.error", code: "INVALID_REQUEST" });
      if (!vapidKey) return send(conn.ws, { type: "relay.error", code: "PUSH_NOT_CONFIGURED" });
      const sub = pushSubs.get(deviceId);
      if (!sub) return send(conn.ws, { type: "relay.ok", role: "host", deviceId, delivered: false });
      // Delivery is async (network POST); the ack only means "accepted".
      void deliverWebPush(deviceId, sub, frame)
        .then((delivered) => log(`push ${str(frame.kind, 32) || "?"} → ${deviceId}: ${delivered ? "sent" : "failed"}`))
        .catch((error) => log(`push to ${deviceId} error:`, error?.message ?? error));
      return send(conn.ws, { type: "relay.ok", role: "host", deviceId });
    }

    default: {
      // Data frame → must carry plaintext routing target `to` = deviceId.
      const to = str(frame.to, 128);
      if (!to) return send(conn.ws, { type: "relay.error", code: "NO_ROUTE" });
      const rec = devices.get(to);
      if (!rec || !isWsOpen(rec.ws)) {
        return send(conn.ws, { type: "relay.error", code: rec ? "DEVICE_OFFLINE" : "UNKNOWN_DEVICE", to });
      }
      // Forward the whole object unchanged (opaque to the relay).
      return send(rec.ws, frame);
    }
  }
}

// --- device frames ---------------------------------------------------------------------
function handleDeviceFrame(conn, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return send(conn.ws, { type: "relay.error", code: "INVALID_JSON" });
  }
  if (!frame || typeof frame !== "object") return send(conn.ws, { type: "relay.error", code: "INVALID_REQUEST" });

  switch (frame.type) {
    case "hello": {
      const deviceId = str(frame.deviceId, 128);
      const rec = devices.get(deviceId);
      if (!rec || !rec.token || rec.token !== str(frame.deviceToken, 128)) {
        log(`device ${deviceId || "?"} hello rejected (auth failed)`);
        tryClose(conn.ws, CLOSE_AUTH_FAILED, "AUTH_FAILED");
        return;
      }
      if (isWsOpen(rec.ws) && rec.ws !== conn.ws) {
        send(rec.ws, { type: "replaced" });
        tryClose(rec.ws, CLOSE_REPLACED, "REPLACED");
      }
      rec.ws = conn.ws;
      conn.role = "device";
      conn.id = deviceId;
      log(`device ${deviceId} hello ok (host ${rec.hostId})`);
      // Tell the host uplink so it can re-issue a pair.challenge for the
      // signature handshake (S1 relay-uplink consumes this control frame).
      const host = hosts.get(rec.hostId);
      if (isWsOpen(host?.ws)) send(host.ws, { type: "device.online", deviceId });
      return send(conn.ws, { type: "relay.ok", role: "device", hostId: rec.hostId });
    }

    case "pair.request": {
      const ticket = str(frame.ticket, 128);
      const deviceId = str(frame.deviceId, 128);
      if (!ticket || !deviceId) return send(conn.ws, { type: "relay.error", code: "INVALID_REQUEST" });
      const t = tickets.get(ticket);
      if (!t || t.used) return send(conn.ws, { type: "relay.error", code: "TICKET_INVALID" });
      if (t.expiresAt <= Date.now()) {
        tickets.delete(ticket);
        return send(conn.ws, { type: "relay.error", code: "TICKET_EXPIRED" });
      }
      const host = hosts.get(t.hostId);
      // Do not consume the ticket when the host is offline so a legitimate
      // retry works once it reconnects.
      if (!isWsOpen(host?.ws)) return send(conn.ws, { type: "relay.error", code: "HOST_OFFLINE" });
      t.used = true;
      const existing = devices.get(deviceId);
      if (existing && isWsOpen(existing.ws) && existing.ws !== conn.ws) {
        send(existing.ws, { type: "replaced" });
        tryClose(existing.ws, CLOSE_REPLACED, "REPLACED");
      }
      devices.set(deviceId, { ws: conn.ws, hostId: t.hostId, token: null, status: "pending", name: str(frame.name, 80) || deviceId });
      conn.role = "device";
      conn.id = deviceId;
      log(`pair.request ${deviceId} routed to host ${t.hostId}`);
      return send(host.ws, frame); // forward unchanged; S1 uplink maps it into RemoteHost.handleHello
    }

    default: {
      if (conn.role !== "device") return send(conn.ws, { type: "relay.error", code: "NOT_AUTHENTICATED" });
      const rec = devices.get(conn.id);
      // Pending (not yet approved) sockets may only exchange control frames —
      // except pair.hello, which IS the pairing handshake. Checking `type`
      // inspects routing metadata only, never frame content.
      if (!rec || (rec.status !== "approved" && frame.type !== "pair.hello")) {
        return send(conn.ws, { type: "relay.error", code: "NOT_AUTHENTICATED" });
      }
      const host = hosts.get(rec.hostId);
      if (!isWsOpen(host?.ws)) return send(conn.ws, { type: "relay.error", code: "HOST_OFFLINE" });
      // Tag the sender (routing metadata only; payload stays opaque). The
      // host uplink needs it to map the frame onto a connection.
      return send(host.ws, { from: conn.id, ...frame });
    }
  }
}

// --- server -----------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.split("?")[0] === "/healthz") {
    const onlineDevices = [...devices.values()].filter((d) => isWsOpen(d.ws)).length;
    const paired = [...devices.values()].filter((d) => d.status === "approved").length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, hosts: hosts.size, devices: onlineDevices, paired, tickets: tickets.size, pushSubs: pushSubs.size, uptimeSec: Math.round(process.uptime()) }));
    return;
  }
  // S7: the PWA fetches this to subscribe() with the application server key.
  if (req.method === "GET" && req.url?.split("?")[0] === "/api/v1/remote/web-push/vapid-public-key") {
    res.writeHead(vapidKey ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(vapidKey ? { publicKey: vapidKey.pubB64u } : { error: "push not configured" }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  const conn = { role: null, id: "", ws };
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data) => {
    const raw = data.toString();
    if (raw.length > MAX_FRAME_BYTES) {
      send(ws, { type: "relay.error", code: "PAYLOAD_TOO_LARGE" });
      tryClose(ws, CLOSE_TOO_LARGE, "PAYLOAD_TOO_LARGE");
      return;
    }
    if (conn.role === null) {
      // First frame decides the role.
      let frame = null;
      try {
        frame = JSON.parse(raw);
      } catch { /* handled below */ }
      const type = frame && typeof frame === "object" ? frame.type : "";
      if (type === "host.register") {
        const hostId = str(frame.hostId, 64);
        if (!hostId) return tryClose(ws, CLOSE_BAD_FIRST_FRAME, "BAD_FIRST_FRAME");
        const existing = hosts.get(hostId);
        if (existing && isWsOpen(existing.ws)) {
          log(`host ${hostId} replaced`);
          send(existing.ws, { type: "replaced" });
          tryClose(existing.ws, CLOSE_REPLACED, "REPLACED");
        }
        hosts.set(hostId, { ws });
        conn.role = "host";
        conn.id = hostId;
        log(`host ${hostId} registered`);
        send(ws, { type: "relay.ok", role: "host" });
      } else if (type === "hello" || type === "pair.request") {
        handleDeviceFrame(conn, raw);
      } else {
        tryClose(ws, CLOSE_BAD_FIRST_FRAME, "BAD_FIRST_FRAME");
      }
      return;
    }
    if (conn.role === "host") handleHostFrame(conn, raw);
    else handleDeviceFrame(conn, raw);
  });

  ws.on("close", () => dropSocket(conn));
  ws.on("error", () => { /* close follows */ });
});

// Heartbeat: ping every PING_MS; a socket that misses DEAD_MS/PING_MS pings is dead.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate(); // 'close' fires → dropSocket cleans routing + notifies peer
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch { /* noop */ }
  });
}, PING_MS);

server.listen(PORT, HOST, () => {
  const actual = server.address()?.port ?? PORT;
  log(`ready ws://${HOST}:${actual}/ws (ping ${PING_MS}ms, dead ~${DEAD_MS}ms)`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(heartbeat);
    wss.clients.forEach((ws) => ws.close(1001, "relay shutting down"));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
