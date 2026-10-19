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
 *
 * **第二个监听（公网明文）**：`RELAY_PLAIN_PORT`（可选）+ `RELAY_PLAIN_HOST`（默认 0.0.0.0）。
 *   为什么需要（2026-09-29）：国内链路会**按 TLS 握手指纹**给连接注入 RST（安卓 OkHttp 被掐、
 *   Chrome/OpenSSL 放行），所以手机从公网只能走**明文** ws/http；而主机（在 Tailscale 里）
 *   继续用 tailnet 上那条 TLS 监听。两个监听**共用同一个进程/同一套路由表**——
 *   否则分属两个中继实例的设备根本互相看不见（帧路由是按连接登记的）。
 *   明文侧同样服务 `/ws` 与 `/download/*`，于是手机的「控制通道」和「更新下载」都不再依赖 Tailscale。
 */
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import { encryptWebPushPayload, loadOrCreateVapidKey, vapidJwt, webPushHeaders } from "./vapid.mjs";

const PORT = Number(process.env.RELAY_PORT || 9001);
const HOST = process.env.RELAY_HOST || "0.0.0.0";
/** 可选的第二个监听：公网明文（0 / 未设 = 不开）。见文件头注释。 */
const PLAIN_PORT = Number(process.env.RELAY_PLAIN_PORT || 0);
const PLAIN_HOST = process.env.RELAY_PLAIN_HOST || "0.0.0.0";
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
  // 桌面端自更新（electron-updater 的 generic provider）：latest.yml + 安装包。
  // 未列出的扩展名一律 octet-stream（.exe / .blockmap 就是靠这条）。
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
};

/**
 * 解析单段 `Range: bytes=…`（多段只取第一段——浏览器与 electron-updater 都只发单段）。
 * 返回 null 表示没有/不支持 Range（调用方回 200 全量），{invalid:true} 回 416。
 *
 * 为什么必须要它：安装包 138MB，而 elecron-updater 的**差量下载（.blockmap）与断点续传
 * 都靠 Range**；没有 Range 就只能每次整包重下，而且旧实现 readFile 把整个文件吃进内存。
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim().split(",")[0].trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { invalid: true };
  let start;
  let end;
  if (rawStart === "") {
    // 后缀式：最后 N 字节
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

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
  // 桌面安装包镜像只给授权的电脑（软/硬门控，见上方 app-mirror 注释）。
  if (pathname === APP_MIRROR_PREFIX || pathname.startsWith(APP_MIRROR_PREFIX + "/")) {
    if (gateAppMirror(req, res, pathname)) return true;
  }
  const filePath = resolve(join(root, pathname));
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return true;
  }
  const sendFile = (file) => {
    stat(file).then((st) => {
      if (st.isDirectory()) return sendFile(join(file, "index.html"));
      const size = st.size;
      const headers = {
        "content-type": STATIC_TYPES[extname(file)] || "application/octet-stream",
        "content-length": String(size),
        // electron-updater 的差量下载与断点续传都依赖这个头。
        "accept-ranges": "bytes",
        "last-modified": st.mtime.toUTCString(),
      };
      // index.html must never be cached (asset filenames are content-hashed).
      if (extname(file) === ".html") headers["cache-control"] = "no-cache";
      const range = parseRange(req.headers.range, size);
      if (range && range.invalid) {
        res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": "0" });
        res.end();
        return;
      }
      if (range) {
        headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
        headers["content-length"] = String(range.end - range.start + 1);
        res.writeHead(206, headers);
        if (headOnly) {
          res.end();
          return;
        }
        pipeFile(file, res, range);
        return;
      }
      res.writeHead(200, headers);
      if (headOnly) {
        res.end();
        return;
      }
      pipeFile(file, res, null);
    }).catch(() => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  };
  /** 流式发送（不再 readFile 整包进内存）；客户端断开时同步销毁读流。 */
  const pipeFile = (file, res, range) => {
    const source = createReadStream(file, range ? { start: range.start, end: range.end } : undefined);
    source.on("error", () => res.destroy());
    res.on("close", () => source.destroy());
    source.pipe(res);
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
/**
 * 主机准入（P1，2026-09-30）：中继对外提供服务时，不能让任何人白用。
 *
 * 规则（"给了 token 列表才启用"）：
 *   · `RELAY_HOST_TOKENS=token1,token2` 或 `RELAY_TOKEN_FILE=/path`（每行一个，`#` 开头为注释）
 *   · 两个都没给 / 列表为空 → **开放模式**（自用、局域网内嵌中继、测试）；
 *   · 给了列表 → `host.register` 必须带 `token` 且命中列表，否则
 *     `relay.error{code:"HOST_UNAUTHORIZED"}` + 断开（4003）。
 *
 * 为什么要一朋友一 token：可精确吊销、后续可接用量统计；token 只用于 **host→relay 注册**，
 * **绝不能进配对票**（否则朋友的手机也拿到主机凭证）。见 docs/RELAY-SHARING.md §3.1。
 */
const HOST_TOKENS_ENV = (process.env.RELAY_HOST_TOKENS || "")
  .split(",")
  .map((token) => token.trim())
  .filter(Boolean);
const HOST_TOKEN_FILE = process.env.RELAY_TOKEN_FILE || "";

function loadHostTokens() {
  const tokens = new Set(HOST_TOKENS_ENV);
  if (HOST_TOKEN_FILE) {
    try {
      for (const line of readFileSync(HOST_TOKEN_FILE, "utf8").split(/\r?\n/)) {
        const token = line.trim();
        if (token && !token.startsWith("#")) tokens.add(token);
      }
    } catch (error) {
      log(`host token file unreadable (${HOST_TOKEN_FILE}): ${error?.message || error}`);
    }
  }
  return tokens;
}

/** 每 5s 重读一次 token 文件：吊销/新增不用重启中继（env 那份不可热改）。 */
let hostTokens = loadHostTokens();
function refreshHostTokens() {
  if (!HOST_TOKEN_FILE) return;
  hostTokens = loadHostTokens();
}

/** 常量时间比较（避免用时长泄露 token 前缀）；命中时返回**命中的那个 token**（设备额度要用）。 */
function matchedHostToken(candidate) {
  if (typeof candidate !== "string" || !candidate) return null;
  const a = Buffer.from(candidate);
  let matched = null;
  for (const token of hostTokens) {
    const b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) matched = token;
  }
  return matched;
}

const hostAuthRequired = () => hostTokens.size > 0;

/**
 * **设备额度**（2026-10-16）：一个授权码最多 N 台设备。
 *
 * 为什么需要：授权码是共享口令（一台机器填一次就完），如果不管设备数，码一旦流出去
 * 就能被无限台机器白嫖这台中继。主流做法（ngrok authtoken / Tailscale auth key 那类）
 * 都是「按设备登记 + 可撤销」，这里用最小的形态实现它：
 *
 *   · **设备 = hostId**（主机进程生成并持久化的 id，见 relay-uplink）；
 *   · 码列表仍由人维护（`RELAY_TOKEN_FILE`，加删一行即生效）；设备表由中继自己写，
 *     落在 `RELAY_AUTH_FILE`（默认不启用，兼容旧部署）；
 *   · 同一 hostId 重连只更新 lastSeen，不占新额度；设备数满了 → `HOST_DEVICE_LIMIT` 拒绝；
 *   · 撤销：删设备表里那条（或整个文件）即可，无需重启（下次注册重新计数）。
 */
const AUTH_DEVICES_FILE = process.env.RELAY_AUTH_FILE || "";
const AUTH_MAX_DEVICES = Math.max(1, Number(process.env.RELAY_AUTH_MAX_DEVICES || 3));

function loadAuthDevices() {
  if (!AUTH_DEVICES_FILE) return {};
  try {
    const parsed = JSON.parse(readFileSync(AUTH_DEVICES_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out = {};
    for (const [code, list] of Object.entries(parsed)) {
      if (!Array.isArray(list)) continue;
      out[code] = list
        .filter((item) => item && typeof item.hostId === "string" && item.hostId)
        .map((item) => ({
          hostId: item.hostId,
          name: typeof item.name === "string" ? item.name : "",
          firstSeen: typeof item.firstSeen === "string" ? item.firstSeen : new Date().toISOString(),
          lastSeen: typeof item.lastSeen === "string" ? item.lastSeen : new Date().toISOString(),
        }));
    }
    return out;
  } catch (error) {
    // 文件不存在是正常情况（第一次跑）；真读坏了也不能把中继带崩。
    if (error?.code !== "ENOENT") log(`auth device file unreadable (${AUTH_DEVICES_FILE}): ${error?.message || error}`);
    return {};
  }
}

/** 原子写（tmp + rename）：写一半挂掉也不会把设备表留成半截 JSON。 */
function saveAuthDevices() {
  if (!AUTH_DEVICES_FILE) return;
  try {
    const tmp = `${AUTH_DEVICES_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(authDevices, null, 2));
    renameSync(tmp, AUTH_DEVICES_FILE);
  } catch (error) {
    log(`auth device file write failed (${AUTH_DEVICES_FILE}): ${error?.message || error}`);
  }
}

let authDevices = loadAuthDevices();

/** 日志里不回显明文码（前 8 位已够区分）。 */
const codeFp = (code) => String(code || "").slice(0, 8);

/** 登记/续期一次注册（`name` = 机器名，给人看）；满额返回 `{ok:false}`。 */
function registerAuthDevice(code, hostId, name = "") {
  if (!AUTH_DEVICES_FILE) return { ok: true, devices: 0, counted: false, activated: true };
  const list = authDevices[code] || (authDevices[code] = []);
  const now = new Date().toISOString();
  const cleanName = String(name || "").trim().slice(0, 64);
  const existing = list.find((item) => item.hostId === hostId);
  if (existing) {
    existing.lastSeen = now;
    if (cleanName) existing.name = cleanName;
    saveAuthDevices();
    return { ok: true, devices: list.length, counted: false, activated: true };
  }
  if (list.length >= AUTH_MAX_DEVICES) return { ok: false, devices: list.length, counted: false, activated: false };
  list.push({ hostId, name: cleanName, firstSeen: now, lastSeen: now });
  saveAuthDevices();
  return { ok: true, devices: list.length, counted: true, activated: true };
}

/** 解除绑定（激活窗口的「解除绑定」）：删掉这台 → 腾出名额。 */
function removeAuthDevice(code, hostId) {
  if (!AUTH_DEVICES_FILE) return { removed: false, devices: 0 };
  const list = authDevices[code] || [];
  authDevices[code] = list.filter((item) => item.hostId !== hostId);
  const removed = authDevices[code].length !== list.length;
  if (removed) saveAuthDevices();
  return { removed, devices: authDevices[code].length };
}

/** 设备清单（激活窗口自己看：带 hostId 是为了标出「这台」）。 */
function authzDevices(code) {
  return (authDevices[code] || []).map((item) => ({ hostId: item.hostId, name: item.name, lastSeen: item.lastSeen }));
}

/**
 * `/authz/check` 的返回：用量 + 码指纹 + （给了 hostId 时）这台有没有登记。
 * `deviceList` 默认不回（避免拿码的人枚举别人的机器），激活窗口显式要才给。
 */
function authzSummary(code, hostId = "", includeDevices = false) {
  const list = authDevices[code] || [];
  return {
    ok: true,
    code: codeFp(code),
    devices: list.length,
    maxDevices: AUTH_MAX_DEVICES,
    enforcing: Boolean(AUTH_DEVICES_FILE),
    ...(hostId ? { activated: list.some((item) => item.hostId === hostId) } : {}),
    ...(includeDevices ? { deviceList: authzDevices(code) } : {}),
  };
}

/** 读一个小 JSON 请求体（限 8KB；中继不解析业务帧，但自检/激活这几条要参数）。 */
function readJsonBody(req, limit = 8 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** 检查结果：ok / 拒因（调用方负责回错并断开）；`token` = 命中的授权码（空 = 开放模式）。 */
function checkHostAuth(frame) {
  if (!hostAuthRequired()) return { ok: true, token: "" };
  const matched = matchedHostToken(frame.token);
  return matched ? { ok: true, token: matched } : { ok: false, token: "" };
}

/**
 * 骚扰加固（2026-10-16，用户要求"全做"）。
 *
 * 威胁模型：地址公开是必然的（手机要连），**激活码**才是钥匙。但地址公开后仍有两类骚扰：
 *   ① 反复猜码 / 反复建连（每次失败都要走一遍鉴权与日志）；
 *   ② 单 IP 开一堆 WS 连接占资源。
 * 这里用最小的形态挡住（内存态、按 IP 计）：
 *   · 认证类失败（host.register 未授权、/authz/* 错码）→ 记一笔；
 *     60s 窗口内失败 ≥ `RELAY_AUTH_FAIL_LIMIT`（默认 10）→ 该 IP **封 60s**（不再走鉴权）；
 *     ⚠️ 封禁只作用于**拿错凭证的 host.register** 与 `/authz/*`，**不拦 `/ws` upgrade**，
 *     也不拦凭证正确的主机与设备——同 NAT 后面的合法端不该被一台配错凭证的机器连坐
 *     （见 attachUpgrade / host.register 处的注释，2026-10-19）。
 *   · 单 IP 并发 WS 连接 > `RELAY_MAX_WS_PER_IP`（默认 20）→ 新连接直接 429；
 *   · 计时表定期清理（防 IP 海量变化把表撑爆）。
 *
 * ⚠️ 反代后面所有请求都来自同一个 IP（CF/nginx 默认只给 127.0.0.1）：那时以 `X-Forwarded-For`
 * 第一跳为准；自建直连（当前 ECS 就是）本来就只有真实 IP。
 */
const AUTH_FAIL_LIMIT = Math.max(1, Number(process.env.RELAY_AUTH_FAIL_LIMIT || 10));
const AUTH_BLOCK_MS = Math.max(1000, Number(process.env.RELAY_AUTH_BLOCK_MS || 60_000));
const MAX_WS_PER_IP = Math.max(1, Number(process.env.RELAY_MAX_WS_PER_IP || 20));
const authFailures = new Map();
const wsConns = new Map();

function clientIp(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req?.socket?.remoteAddress || "unknown";
}

function authBlocked(ip) {
  const entry = authFailures.get(ip);
  return Boolean(entry && entry.blockedUntil > Date.now());
}

function noteAuthFailure(ip, why) {
  const now = Date.now();
  const entry = authFailures.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - entry.firstAt > AUTH_BLOCK_MS) {
    entry.count = 0;
    entry.firstAt = now;
  }
  entry.count += 1;
  if (entry.count >= AUTH_FAIL_LIMIT && entry.blockedUntil <= now) {
    entry.blockedUntil = now + AUTH_BLOCK_MS;
    log(`ratelimit ${ip} blocked ${AUTH_BLOCK_MS / 1000}s after ${entry.count} auth failures (last: ${why})`);
  }
  authFailures.set(ip, entry);
}

function noteConn(delta, ip) {
  const next = Math.max(0, (wsConns.get(ip) || 0) + delta);
  if (next === 0) wsConns.delete(ip);
  else wsConns.set(ip, next);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authFailures) {
    if (entry.blockedUntil <= now && now - entry.firstAt > AUTH_BLOCK_MS) authFailures.delete(ip);
  }
  if (authFailures.size > 5000) authFailures.clear();
  if (wsConns.size > 5000) wsConns.clear();
}, 300_000).unref();

/**
 * 桌面自更新镜像的准入（2026-10-16）。
 *
 * 背景：`/download/app/`（安装包 + latest.yml）原来完全公开。现在它只服务
 * 「经我授权的电脑」：客户端带上 `Authorization: Bearer <token>`（见 `src/main/app-updater.ts`）。
 *
 * **软门控**（默认）：令牌列表为空 = 完全开放；配了列表但请求没带/带错 → **只记一行日志，
 * 照常放行**。要真拦需显式 `RELAY_APP_MIRROR_STRICT=1`（返回 401）——为什么分两步：
 * 已经装出去的旧客户端不会带令牌（发版铁律：小版本不推 GitHub），一旦先开硬门控，
 * 它们拿不到新版本、也回退不到 GitHub，只能手工装包。所以先用软门控观察一轮，
 * 确认日志里都是 `token-ok` 后再开严格模式。
 *
 * 令牌源：`RELAY_APP_TOKENS=t1,t2` 或 `RELAY_APP_TOKEN_FILE=/path`（每行一个，`#` 注释），
 * 与主机的 `RELAY_HOST_TOKENS` **分开**（后者只用于 host→relay 注册，改动会踢掉在线主机）。
 */
const APP_MIRROR_TOKENS_ENV = (process.env.RELAY_APP_TOKENS || "")
  .split(",")
  .map((token) => token.trim())
  .filter(Boolean);
const APP_MIRROR_TOKEN_FILE = process.env.RELAY_APP_TOKEN_FILE || "";
const APP_MIRROR_STRICT = process.env.RELAY_APP_MIRROR_STRICT === "1";
/** 镜像目录（尾斜杠）；`/download/app` 也认。 */
const APP_MIRROR_PREFIX = "/download/app";

function loadAppMirrorTokens() {
  const tokens = new Set(APP_MIRROR_TOKENS_ENV);
  if (APP_MIRROR_TOKEN_FILE) {
    try {
      for (const line of readFileSync(APP_MIRROR_TOKEN_FILE, "utf8").split(/\r?\n/)) {
        const token = line.trim();
        if (token && !token.startsWith("#")) tokens.add(token);
      }
    } catch (error) {
      log(`app mirror token file unreadable (${APP_MIRROR_TOKEN_FILE}): ${error?.message || error}`);
    }
  }
  return tokens;
}

let appMirrorTokens = loadAppMirrorTokens();
function refreshAppMirrorTokens() {
  if (!APP_MIRROR_TOKEN_FILE) return;
  appMirrorTokens = loadAppMirrorTokens();
}

function appMirrorTokenMatches(candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  const a = Buffer.from(candidate);
  let matched = false;
  for (const token of appMirrorTokens) {
    const b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  return matched;
}

/**
 * 从请求里取授权码：`Authorization: Bearer <code>` 优先，其次 `?code=`（手动 curl / 健康检查用），
 * 再退回 `?token=`（镜像门控早期的写法，保持兼容）。
 */
function authCodeFromRequest(req) {
  const header = String(req.headers.authorization || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (bearer) return bearer[1].trim();
  try {
    const params = new URL(req.url || "/", "http://localhost").searchParams;
    return params.get("code") || params.get("token") || "";
  } catch {
    return "";
  }
}

/** 镜像门控用同一个提取器。 */
function appMirrorRequestToken(req) {
  return authCodeFromRequest(req);
}

/** 软/硬门控结果：`open`（没配令牌）/`ok`/`missing`/`bad`。 */
function checkAppMirrorAuth(req) {
  if (appMirrorTokens.size === 0) return "open";
  const token = appMirrorRequestToken(req);
  if (!token) return "missing";
  return appMirrorTokenMatches(token) ? "ok" : "bad";
}

/** 软门控的日志节流：同一状态 60s 最多一条，不把日志淹了。 */
let appMirrorLogAt = 0;
let appMirrorLogState = "";
function logAppMirrorSoft(state, pathname) {
  const now = Date.now();
  if (state === appMirrorLogState && now - appMirrorLogAt < 60_000) return;
  appMirrorLogState = state;
  appMirrorLogAt = now;
  log(`app-mirror ${state} ${pathname} (tokens=${appMirrorTokens.size}, strict=${APP_MIRROR_STRICT ? "on" : "off"}${APP_MIRROR_STRICT ? "" : ", serving anyway"})`);
}

/** 镜像路径的准入闸门：返回 true 表示已经回完响应（调用方直接 return）。 */
function gateAppMirror(req, res, pathname) {
  const state = checkAppMirrorAuth(req);
  if (state === "open") return false;
  // 软门控阶段 `ok` 也记一行：要判断「能不能开严格模式」，得先确认客户端确实带上了令牌。
  if (state === "ok") {
    if (!APP_MIRROR_STRICT) logAppMirrorSoft("ok", pathname);
    return false;
  }
  logAppMirrorSoft(state, pathname);
  if (!APP_MIRROR_STRICT) return false;
  res.writeHead(401, { "content-type": "text/plain", "www-authenticate": 'Bearer realm="mpi-app-mirror"' });
  res.end("unauthorized");
  return true;
}

const CLOSE_HOST_RESTARTED = 4007;
/** 主机凭证不对（P1 准入）。 */
const CLOSE_HOST_UNAUTHORIZED = 4003;
/** 授权码设备额度已满（2026-10-16：一个码最多 N 台）。 */
const CLOSE_HOST_DEVICE_LIMIT = 4008;

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

// --- 二进制 E2E 帧（2026-09-30，去 base64 的 33% 膨胀）------------------------------
// 布局：`[版本=1][头长 N][JSON 头][nonce 12B + 密文 + tag 16B]`。
// 中继只解头部（路由元数据 from/to），载荷始终是密文——与 JSON 版行为一致。
const BIN_VERSION = 1;

/** 读头部；不是本格式 → null。 */
function readBinaryFrame(data) {
  if (!data || data.length < 2 || data[0] !== BIN_VERSION) return null;
  const headerLength = data[1];
  if (data.length < 2 + headerLength) return null;
  let header = {};
  if (headerLength > 0) {
    try {
      header = JSON.parse(data.subarray(2, 2 + headerLength).toString("utf8"));
    } catch {
      return null;
    }
  }
  return { header, body: data.subarray(2 + headerLength) };
}

/** 拼一条二进制帧（头部换了、载荷原样）。 */
function rebuildBinaryFrame(header, body) {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  if (head.length > 255) return null;
  return Buffer.concat([Buffer.from([BIN_VERSION, head.length]), head, body]);
}

/** 发一条二进制帧。 */
function sendBinary(ws, buf) {
  if (!isWsOpen(ws)) return false;
  try {
    ws.send(buf, { binary: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 二进制 E2E 帧的路由（设备↔主机）。载荷不解、只改头部。
 *
 * 设备→主机：给头部补 `from`（上行靠它把帧映射到具体连接），跟 JSON 版一样只做路由元数据。
 * 主机→设备：按头部的 `to` 找设备。未批准的设备与 JSON 路径同规矩。
 */
function handleBinaryMessage(conn, data) {
  const decoded = readBinaryFrame(data);
  if (!decoded) {
    send(conn.ws, { type: "relay.error", code: "INVALID_FRAME" });
    return;
  }
  if (conn.role === "host") {
    const to = str(decoded.header.to, 128);
    const rec = to ? devices.get(devKey(conn.id, to)) : undefined;
    if (!rec || !isWsOpen(rec.ws)) {
      send(conn.ws, { type: "relay.error", code: "DEVICE_OFFLINE" });
      return;
    }
    const out = rebuildBinaryFrame({ to }, decoded.body);
    if (out) {
      log(`bin ${decoded.body.length}B host→${to}`);
      sendBinary(rec.ws, out);
    }
    return;
  }
  if (conn.role === "device") {
    const rec = conn.authHostId ? devices.get(devKey(conn.authHostId, conn.id)) : undefined;
    if (!rec || rec.status !== "approved") {
      send(conn.ws, { type: "relay.error", code: "NOT_AUTHENTICATED" });
      return;
    }
    const host = hosts.get(rec.hostId);
    if (!isWsOpen(host?.ws)) {
      send(conn.ws, { type: "relay.error", code: "HOST_OFFLINE" });
      return;
    }
    const out = rebuildBinaryFrame({ from: conn.id }, decoded.body);
    if (out) {
      log(`bin ${decoded.body.length}B ${conn.id}→host`);
      sendBinary(host.ws, out);
    }
    return;
  }
  tryClose(conn.ws, CLOSE_BAD_FIRST_FRAME, "BAD_FIRST_FRAME");
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
        // **故意不计入限速**：主机重启/换域名后，手机带着旧令牌重试是正常现象（重连期可能每 2s 一次），
        // 按 IP 封掉会把你自己的手机锁在门外。真正的暴力面是「猜激活码」（host.register / /authz/*）。
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
async function onRequest(req, res) {
  if (req.method === "GET" && req.url?.split("?")[0] === "/healthz") {
    // 收敛（2026-10-16）：配了准入（对外服务）时，**没带有效激活码只回 {ok:true}**——
    // 之前公开回 hosts/devices/tickets 计数，等于免费给扫描者做情报。自用/开放模式保持原样。
    const ip = clientIp(req);
    if (authBlocked(ip)) {
      // 封禁优先：被封的 IP 连健康检查也不给（否则等于留了个可用的探测信道）。
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "RATE_LIMITED" }));
      return;
    }
    if (hostAuthRequired() && !matchedHostToken(authCodeFromRequest(req))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
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
  /**
   * 激活（授权）三件套（2026-10-16）：
   *   GET  /authz/check       → 通不通 / 码对不对 / 名额用量（「验证连通性」）
   *   POST /authz/activate    → 登记这台（「立即激活」；满额 409）
   *   POST /authz/deactivate  → 删掉这台（「解除绑定」，腾名额）
   * 都要 `Authorization: Bearer <激活码>`；中继没配码列表时按开放模式返回。
   */
  const authzPath = req.url?.split("?")[0] || "";
  if (req.method === "POST" && (authzPath === "/authz/activate" || authzPath === "/authz/deactivate")) {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const body = await readJsonBody(req);
    const hostId = body && typeof body.hostId === "string" ? body.hostId.trim().slice(0, 64) : "";
    if (!hostId) {
      reply(400, { ok: false, error: "MISSING_HOST_ID" });
      return;
    }
    if (!hostAuthRequired()) {
      reply(200, { ok: true, open: true, code: "", devices: 0, maxDevices: AUTH_MAX_DEVICES, enforcing: false, activated: true });
      return;
    }
    const ip = clientIp(req);
    if (authBlocked(ip)) {
      reply(429, { ok: false, error: "RATE_LIMITED" });
      return;
    }
    const code = matchedHostToken(authCodeFromRequest(req));
    if (!code) {
      noteAuthFailure(ip, "authz bad code");
      reply(401, { ok: false, error: "BAD_CODE" });
      return;
    }
    if (authzPath === "/authz/activate") {
      const reg = registerAuthDevice(code, hostId, body && typeof body.name === "string" ? body.name : "");
      if (!reg.ok) {
        log(`auth activate rejected ${codeFp(code)} host=${hostId} (limit ${reg.devices}/${AUTH_MAX_DEVICES})`);
        reply(409, { ok: false, error: "HOST_DEVICE_LIMIT", devices: reg.devices, maxDevices: AUTH_MAX_DEVICES });
        return;
      }
      log(`auth activate ${codeFp(code)} host=${hostId}${reg.counted ? "" : " (already bound)"} (${reg.devices}/${AUTH_MAX_DEVICES})`);
      reply(200, authzSummary(code, hostId, true));
      return;
    }
    const removed = removeAuthDevice(code, hostId);
    log(`auth deactivate ${codeFp(code)} host=${hostId} removed=${removed.removed} (${removed.devices}/${AUTH_MAX_DEVICES})`);
    reply(200, { ...authzSummary(code, hostId, true), removed: removed.removed });
    return;
  }
  // 授权码自检（桌面端「验证连通性」用）：服务器通不通 / 码对不对 / 还剩几个设备名额。
  // 只回用量与码指纹，不回设备 id（那些留在设备表文件里）。
  if (req.method === "GET" && authzPath === "/authz/check") {
    const sendJson = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!hostAuthRequired()) {
      sendJson(200, { ok: true, open: true, code: "", devices: 0, maxDevices: AUTH_MAX_DEVICES, enforcing: false });
      return;
    }
    const ip = clientIp(req);
    if (authBlocked(ip)) {
      sendJson(429, { ok: false, error: "RATE_LIMITED" });
      return;
    }
    const code = authCodeFromRequest(req);
    const matched = matchedHostToken(code);
    if (!matched) {
      noteAuthFailure(ip, "authz check bad code");
      sendJson(401, { ok: false, error: "BAD_CODE" });
      return;
    }
    // 注意：必须把查询里的 hostId 带进来，否则 activated 恒为 undefined ——
    // 界面就会在"服务器已登记本机"的同时显示"未激活"（2026-10-16 实测踩到）。
    const query = new URL(req.url || "/", "http://localhost").searchParams;
    sendJson(200, authzSummary(matched, (query.get("hostId") || "").trim().slice(0, 64)));
    return;
  }
  if (serveStatic(req, res)) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

const server = tlsOptions ? https.createServer(tlsOptions, onRequest) : http.createServer(onRequest);

const wss = new WebSocketServer({ noServer: true });

/** 给一个 HTTP(S) server 挂上 `/ws` 升级处理（两个监听共用同一个 wss ⇒ 设备互相可见）。 */
function attachUpgrade(target) {
  target.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    // ⚠️ 这里**只看并发额度，不看 authBlocked**（2026-10-19 修）。
    //
    // 事故：一个未授权的主机（新身份 + 没配 token）在同一个 NAT 后面每 ~2s 重试一次
    // `host.register`，10 次失败 → 该 IP 被封 60s。而那 60s 里 `/ws` upgrade 也被拒（429），
    // 于是**同一路由器后面的合法设备（PWA 浏览器）和这台主机自己的断线重连全都被连坐**：
    // 实测该 IP 有 ~75% 的时间开不出任何连接（还有 `设备 → 主机` 的 hello 明明是豁免计数的，
    // 却也在这层被拦掉）。封禁的真实目的只是「别反复做鉴权/别刷日志」，而首帧拒绝
    // （`host.register` 里的 authBlocked 分支 → RATE_LIMITED + close）已经足够，且**只作用于
    // host 角色**——设备侧不受影响。真正的资源保护由下面的 MAX_WS_PER_IP 负责。
    if ((wsConns.get(ip) || 0) >= MAX_WS_PER_IP) {
      log(`upgrade rejected ip=${ip} conns=${wsConns.get(ip) || 0}/${MAX_WS_PER_IP}`);
      try {
        socket.write("HTTP/1.1 429 Too Many Requests" + String.fromCharCode(13,10) + "Connection: close" + String.fromCharCode(13,10) + String.fromCharCode(13,10));
      } catch { /* socket 可能已经关了 */ }
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}

attachUpgrade(server);

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  noteConn(1, ip);
  ws.on("close", () => noteConn(-1, ip));
  const conn = { role: null, id: "", authHostId: "", ws };
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data, isBinary) => {
    // 二进制 = E2E 数据帧（中继只解头部、不碰载荷，与 JSON 版同样的路由规矩）。
    if (isBinary) {
      if (data.length > MAX_FRAME_BYTES) {
        send(ws, { type: "relay.error", code: "PAYLOAD_TOO_LARGE" });
        tryClose(ws, CLOSE_TOO_LARGE, "PAYLOAD_TOO_LARGE");
        return;
      }
      handleBinaryMessage(conn, data);
      return;
    }
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
        // P1 准入：给了 token 列表就必须命中（开放模式直接放行）。
        //
        // ⚠️ 顺序很重要（2026-10-19）：**先验凭证，再看 IP 封禁**。
        // 以前先看封禁，于是同一 NAT 后面只要有一台机器配错凭证把 IP 封住，
        // 它旁边的**合法主机**也会被 RATE_LIMITED 挡在门外（连断线重连都起不来）。
        // 现在凭证对就直接放行——封禁只拦「拿错凭证反复试」的那条路径（成本只是一次
        // 字符串比较，同时日志降噪：封禁期内不再每个请求打一行，实测一台机器一天刷 320 条）。
        const ip = clientIp(req);
        const auth = checkHostAuth(frame);
        if (!auth.ok) {
          const blocked = authBlocked(ip);
          if (!blocked) {
            noteAuthFailure(ip, "host.register unauthorized");
            log(`host ${hostId} rejected (unauthorized)`);
          }
          send(ws, { type: "relay.error", code: blocked ? "RATE_LIMITED" : "HOST_UNAUTHORIZED" });
          return tryClose(ws, CLOSE_HOST_UNAUTHORIZED, blocked ? "RATE_LIMITED" : "HOST_UNAUTHORIZED");
        }
        // 设备额度（一个码最多 N 台；同一 hostId 重连不占新名额）。仅当配了设备表文件时启用。
        if (auth.token) {
          const reg = registerAuthDevice(auth.token, hostId, str(frame.name, 64));
          if (!reg.ok) {
            log(`host ${hostId} rejected (device limit ${reg.devices}/${AUTH_MAX_DEVICES} for code ${codeFp(auth.token)})`);
            send(ws, { type: "relay.error", code: "HOST_DEVICE_LIMIT", max: AUTH_MAX_DEVICES, devices: reg.devices });
            return tryClose(ws, CLOSE_HOST_DEVICE_LIMIT, "HOST_DEVICE_LIMIT");
          }
          if (reg.counted) log(`auth device registered ${codeFp(auth.token)} host=${hostId} (${reg.devices}/${AUTH_MAX_DEVICES})`);
        }
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

// 主机准入：token 文件每 5s 重读一次（吊销/新增不用重启；env 那份不可热改）。
if (HOST_TOKEN_FILE) {
  setInterval(refreshHostTokens, 5_000).unref();
  setInterval(refreshAppMirrorTokens, 5_000).unref();
}

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
  log(
    `ready ${scheme}://${HOST}:${actual}/ws (ping ${PING_MS}ms, dead ~${DEAD_MS}ms${STATIC_DIR ? ", static: " + STATIC_DIR : ""}, hosts: ${hostAuthRequired() ? `${hostTokens.size} token(s)` : "OPEN"}, app-mirror: ${appMirrorTokens.size === 0 ? "OPEN" : `${appMirrorTokens.size} token(s)${APP_MIRROR_STRICT ? "/strict" : "/soft"}`})`,
  );
});

// 第二个监听：公网明文（同一个 wss / 同一套路由）。手机从公网只能走明文，见文件头注释。
let plainServer = null;
if (PLAIN_PORT) {
  plainServer = http.createServer(onRequest);
  attachUpgrade(plainServer);
  plainServer.listen(PLAIN_PORT, PLAIN_HOST, () => {
    const actual = plainServer.address()?.port ?? PLAIN_PORT;
    log(`ready ws://${PLAIN_HOST}:${actual}/ws (plain, public listener${STATIC_DIR ? ", static: " + STATIC_DIR : ""})`);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(heartbeat);
    wss.clients.forEach((ws) => ws.close(1001, "relay shutting down"));
    plainServer?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
