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
 *   device→ relay : first frame {hello (carries hostId) | pair.request}; afterwards
 *                   opaque data frames are forwarded to the bound host uplink.
 *
 * Env: RELAY_PORT (default 9001, 0 = ephemeral), RELAY_HOST (default 0.0.0.0),
 *      RELAY_PING_MS (default 20000), RELAY_DEAD_MS (default 60000),
 *      RELAY_VAPID_KEY_FILE (default <script dir>/data/vapid.json),
 *      RELAY_VAPID_SUB (JWT `sub` claim, default mailto:relay@mpi.local),
 *      RELAY_ALLOW_INSECURE_PUSH=1 permits http:// push endpoints (tests only).
 *
 * S8 deployment mode (all optional; off by default so tests stay plain HTTP):
 *   RELAY_TLS_CERT / RELAY_TLS_KEY — PEM paths; serve wss:// + https instead of ws://.
 *   RELAY_STATIC_DIR — directory with the built PWA; unknown GET paths fall back to
 *     index.html (SPA deep links like /thread/<id>). Path traversal is rejected.
 */
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import { encryptWebPushPayload, loadOrCreateVapidKey, vapidJwt, webPushHeaders } from "./vapid.mjs";

const PORT = Number(process.env.RELAY_PORT || 9001);
const HOST = process.env.RELAY_HOST || "0.0.0.0";
const PING_MS = Math.max(500, Number(process.env.RELAY_PING_MS || 20_000));
/** A socket that misses DEAD_MS/PING_MS consecutive pings is dead (default ~60s). */
const DEAD_MS = Math.max(PING_MS * 2, Number(process.env.RELAY_DEAD_MS || 60_000));
/** Transport-level frame cap. Must fit large thread snapshots: real sessions
 * reach ~8MB of history, and E2E base64 adds ~33% on top (≈11MB frames).
 * The host still enforces its own 2MB protocol cap on INBOUND device→host
 * frames (protocol.ts parseEnvelope) — this only relaxes the transport. */
const MAX_FRAME_BYTES = 32_000_000;

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

// --- S8 deployment mode: optional TLS termination + PWA static hosting --------------
let tlsOptions = null;
if (process.env.RELAY_TLS_CERT && process.env.RELAY_TLS_KEY) {
  try {
    tlsOptions = { cert: readFileSync(process.env.RELAY_TLS_CERT), key: readFileSync(process.env.RELAY_TLS_KEY) };
  } catch (error) {
    console.error("[relay] TLS material unavailable — falling back to plain HTTP:", error.message);
  }
}
const STATIC_DIR = process.env.RELAY_STATIC_DIR || "";
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Serve RELAY_STATIC_DIR for GETs that no API route claimed. Unknown paths fall
 * back to index.html (SPA deep links). Returns true when the request was handled.
 */
function serveStatic(req, res) {
  // HEAD shares GET's headers (browsers and download tools probe with it) but
  // must not carry a body.
  const headOnly = req.method === "HEAD";
  if (!STATIC_DIR || (req.method !== "GET" && !headOnly)) return false;
  // Strip the query manually — the WHATWG URL parser would normalize %2e
  // dot-segments away and silently rewrite traversal attempts.
  let pathname;
  try {
    pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    return false;
  }
  const root = resolve(STATIC_DIR);
  const filePath = resolve(join(root, pathname));
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return true;
  }
  const sendFile = (file) => {
    readFile(file).then((buf) => {
      const headers = { "content-type": STATIC_TYPES[extname(file)] || "application/octet-stream" };
      // index.html must never be cached (asset filenames are content-hashed).
      if (extname(file) === ".html") headers["cache-control"] = "no-cache";
      res.writeHead(200, headers);
      res.end(headOnly ? undefined : buf);
    }).catch(() => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  };
  stat(filePath).then((st) => {
    if (st.isDirectory()) sendFile(join(filePath, "index.html"));
    else sendFile(filePath);
  }).catch(() => {
    // SPA fallback only for extension-less routes (/thread/<id>); missing
    // assets get a real 404 so the console shows what actually failed.
    if (extname(pathname)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } else {
      sendFile(join(root, "index.html"));
    }
  });
  return true;
}

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
  const { body } = encryptWebPushPayload(Buffer.from(payload, "utf8"), sub.keys);
  const jwt = vapidJwt({ privPem: vapidKey.privPem, aud: new URL(sub.endpoint).origin, sub: VAPID_SUB_CLAIM });
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: webPushHeaders({ jwt, vapidPubB64u: vapidKey.pubB64u }),
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
/** 主机进程换了（真重启）：该主机的设备必须重连重认证——主机内存里的 E2E 会话
 * 密钥已随进程消失，旧连接上的设备再怎么发主机也解不开。见 host.register 的 bootId。 */
const CLOSE_HOST_RESTARTED = 4007;

// --- routing table ---------------------------------------------------------------
/** hostId -> { ws } */
const hosts = new Map();
/** (hostId, deviceId) -> { ws|null, hostId, deviceId, token|null, status:"pending"|"approved", name }.
 * One record per HOST+device pair — a phone can be paired with several desktops,
 * each holding its own token. Keying by the composite stopped two hosts' token
 * announcements from overwriting one shared record (2026-09-22 auth conflict). */
const devices = new Map();
/** Composite key: hostId and deviceId are both opaque strings; NUL cannot appear
 * in a JSON string we accept (str() keeps any chars, but ids come from our own
 * base64url/randomBytes generators) — good enough as a separator. */
const devKey = (hostId, deviceId) => hostId + "\u0000" + deviceId;
/** All records for one device across hosts (legacy hello without hostId matches by token). */
function deviceRecords(deviceId) {
  const out = [];
  for (const rec of devices.values()) if (rec.deviceId === deviceId) out.push(rec);
  return out;
}
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
/** Close-code suffix for `gone` logs — 1006 = network/browser kill, 4003 = frame
 * too large, 4005 = heartbeat timeout, 4006 = replaced by a newer connection. */
function closeInfo(conn) {
  // Captured from the 'close' event args — ws does not populate instance
  // closeCode/closeReason before emitting (verified empirically).
  if (!Number.isInteger(conn.closeCode)) return "";
  return ` (code=${conn.closeCode}${conn.closeReason ? ` "${conn.closeReason}"` : ""})`;
}

/** Remove a leaving socket from the routing table and notify its peer. */
function dropSocket(conn) {
  if (conn.role === "host") {
    const current = hosts.get(conn.id);
    if (current && current.ws === conn.ws) hosts.delete(conn.id);
    log(`host ${conn.id} gone${closeInfo(conn)}`);
    for (const rec of devices.values()) {
      if (rec.hostId === conn.id && isWsOpen(rec.ws)) {
        send(rec.ws, { type: "offline", who: "host", hostId: conn.id });
      }
    }
  } else if (conn.role === "device") {
    // The connection is bound to the host it authenticated against (hello / pair.request).
    const rec = conn.authHostId ? devices.get(devKey(conn.authHostId, conn.id)) : undefined;
    log(`device ${conn.id} gone${closeInfo(conn)}`);
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
      if (!deviceId) return send(conn.ws, { type: "relay.error", code: "INVALID_REQUEST" });
      if (!token) return send(conn.ws, { type: "relay.error", code: "INVALID_TOKEN" });
      // Keyed by (this host, device): each desktop keeps its own token for a
      // phone — no more cross-host overwrites of one shared record.
      const key = devKey(conn.id, deviceId);
      let rec = devices.get(key);
      if (!rec) {
        // Token (re-)registration without a live pending pairing — e.g. the
        // uplink re-announces its stored tokens after a relay restart.
        rec = { ws: null, hostId: conn.id, deviceId, token: null, status: "pending", name: deviceId };
        devices.set(key, rec);
      }
      rec.token = token;
      rec.status = "approved";
      log(`device ${deviceId} approved on host ${conn.id}`);
      return send(conn.ws, { type: "relay.ok", role: "host", deviceId });
    }

    case "device.revoke": {
      const deviceId = str(frame.deviceId, 128);
      // Only this host's own record for the device — other hosts' pairings are untouched.
      const rec = deviceId ? devices.get(devKey(conn.id, deviceId)) : undefined;
      let removed = false;
      if (rec) {
        send(rec.ws, { type: "revoked" });
        tryClose(rec.ws, CLOSE_REVOKED, "REVOKED");
        devices.delete(devKey(conn.id, deviceId));
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
      // Deliver only through the device's socket bound to THIS host — a phone
      // talks to one desktop at a time (records are per host+device).
      let rec = null;
      for (const r of devices.values()) if (r.deviceId === to && r.hostId === conn.id && isWsOpen(r.ws)) { rec = r; break; }
      if (!rec) {
        const boundElsewhere = [...devices.values()].some((r) => r.deviceId === to && isWsOpen(r.ws));
        const known = deviceRecords(to).length > 0;
        const code = boundElsewhere ? "DEVICE_NOT_BOUND" : known ? "DEVICE_OFFLINE" : "UNKNOWN_DEVICE";
        log(`frame ${typeof frame.type === "string" ? frame.type : "<enc>"} ${raw.length}B host→${to} DROPPED (${code})`);
        return send(conn.ws, { type: "relay.error", code, to });
      }
      // Forward the whole object unchanged (opaque to the relay).
      log(`frame ${typeof frame.type === "string" ? frame.type : "<enc>"} ${raw.length}B host→${to}`);
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
      const hostId = str(frame.hostId, 64);
      if (!deviceId) return tryClose(conn.ws, CLOSE_AUTH_FAILED, "AUTH_FAILED");
      // New clients carry the target hostId; legacy builds (no hostId) match by
      // token across all of this device's records.
      const rec = hostId
        ? devices.get(devKey(hostId, deviceId))
        : deviceRecords(deviceId).find((r) => r.token && r.token === str(frame.deviceToken, 128));
      if (!rec || !rec.token || rec.token !== str(frame.deviceToken, 128)) {
        log(`device ${deviceId} hello rejected (auth failed)`);
        tryClose(conn.ws, CLOSE_AUTH_FAILED, "AUTH_FAILED");
        return;
      }
      // R1：同一个 socket 重复 hello（例如设备端重新认证时又发一次 hello）不改变路由，
      // 就不要再通知主机——主机收到 device.online 会关掉并重建**逻辑连接**，把订阅与写
      // 租约一起清空，而设备的传输层（对着中继的这条 WS）根本没断、完全感知不到。
      // 2026-09-24 真机取证：就是这么把手机端的会话订阅静默清掉，之后所有实时事件
      // 被主机丢弃（diag `remote-pub … subs=0`）。
      const socketChanged = rec.ws !== conn.ws;
      if (socketChanged && isWsOpen(rec.ws)) {
        send(rec.ws, { type: "replaced" });
        tryClose(rec.ws, CLOSE_REPLACED, "REPLACED");
        log(`device ${deviceId} REPLACED previous connection`);
      }
      rec.ws = conn.ws;
      conn.role = "device";
      conn.id = deviceId;
      conn.authHostId = rec.hostId;
      log(`device ${deviceId} hello ok (host ${rec.hostId}${socketChanged ? "" : ", same socket → no host re-announce"})`);
      // Tell the host uplink so it can re-issue a pair.challenge for the
      // signature handshake (S1 relay-uplink consumes this control frame).
      // 只有真的换了 socket 才需要——主机必须给新连接发一次新验收。
      const host = hosts.get(rec.hostId);
      if (socketChanged && isWsOpen(host?.ws)) send(host.ws, { type: "device.online", deviceId });
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
      const key = devKey(t.hostId, deviceId);
      const existing = devices.get(key);
      if (existing && isWsOpen(existing.ws) && existing.ws !== conn.ws) {
        send(existing.ws, { type: "replaced" });
        tryClose(existing.ws, CLOSE_REPLACED, "REPLACED");
        log(`device ${deviceId} REPLACED previous connection (pair.request)`);
      }
      devices.set(key, { ws: conn.ws, hostId: t.hostId, deviceId, token: null, status: "pending", name: str(frame.name, 80) || deviceId });
      conn.role = "device";
      conn.id = deviceId;
      conn.authHostId = t.hostId;
      log(`pair.request ${deviceId} routed to host ${t.hostId}`);
      return send(host.ws, frame); // forward unchanged; S1 uplink maps it into RemoteHost.handleHello
    }

    default: {
      if (conn.role !== "device") return send(conn.ws, { type: "relay.error", code: "NOT_AUTHENTICATED" });
      // The connection is bound to the host it authenticated against.
      const rec = conn.authHostId ? devices.get(devKey(conn.authHostId, conn.id)) : undefined;
      // Pending (not yet approved) sockets may only exchange control frames —
      // except pair.hello, which IS the pairing handshake. Checking `type`
      // inspects routing metadata only, never frame content.
      if (!rec || (rec.status !== "approved" && frame.type !== "pair.hello")) {
        return send(conn.ws, { type: "relay.error", code: "NOT_AUTHENTICATED" });
      }
      const host = hosts.get(rec.hostId);
      if (!isWsOpen(host?.ws)) {
        log(`frame ${typeof frame.type === "string" ? frame.type : "<enc>"} ${raw.length}B ${conn.id || "?"}→host DROPPED (HOST_OFFLINE)`);
        return send(conn.ws, { type: "relay.error", code: "HOST_OFFLINE" });
      }
      // Tag the sender (routing metadata only; payload stays opaque). The
      // host uplink needs it to map the frame onto a connection.
      log(`frame ${typeof frame.type === "string" ? frame.type : "<enc>"} ${raw.length}B ${conn.id || "?"}→host`);
      return send(host.ws, { from: conn.id, ...frame });
    }
  }
}

// --- server -----------------------------------------------------------------------------
function onRequest(req, res) {
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
  if (serveStatic(req, res)) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

const server = tlsOptions ? https.createServer(tlsOptions, onRequest) : http.createServer(onRequest);

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
  const conn = { role: null, id: "", authHostId: "", ws };
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
        const bootId = str(frame.bootId, 64);
        const previous = hosts.get(hostId);
        const existing = previous;
        if (existing && isWsOpen(existing.ws)) {
          log(`host ${hostId} replaced`);
          send(existing.ws, { type: "replaced" });
          tryClose(existing.ws, CLOSE_REPLACED, "REPLACED");
        }
        hosts.set(hostId, { ws, bootId });
        conn.role = "host";
        conn.id = hostId;
        // R2'：bootId 变了 = 主机**进程**真的重启了（uplink 网络抖动不会换 bootId）。
        // 主机内存里的会话密钥已随进程消失，旧连接上的设备再发也解不开——必须让它们
        // 重连重认证，走客户端已经跑通的「断线→重连→hello→挑战→认证」老路。
        // 没有 bootId 的老主机构建按「没变」处理：部署期不制造额外的重连 churn。
        const freshProcess = !!bootId && bootId !== (previous?.bootId ?? null);
        let kicked = 0;
        if (freshProcess) {
          for (const rec of devices.values()) {
            if (rec.hostId !== hostId || !isWsOpen(rec.ws)) continue;
            tryClose(rec.ws, CLOSE_HOST_RESTARTED, "HOST_RESTARTED");
            kicked += 1;
          }
        }
        log(`host ${hostId} registered${freshProcess ? ` (fresh process → reconnecting ${kicked} device socket(s))` : ""}`);
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

  ws.on("close", (code, reason) => {
    conn.closeCode = code;
    conn.closeReason = String(reason ?? "");
    dropSocket(conn);
  });
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
  const scheme = tlsOptions ? "wss" : "ws";
  log(`ready ${scheme}://${HOST}:${actual}/ws (ping ${PING_MS}ms, dead ~${DEAD_MS}ms${STATIC_DIR ? ", static: " + STATIC_DIR : ""})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(heartbeat);
    wss.clients.forEach((ws) => ws.close(1001, "relay shutting down"));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
