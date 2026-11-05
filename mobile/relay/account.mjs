/**
 * 账号与个人配置同步（Stage 1：服务端）。
 *
 * 为什么挂在**中继**上而不是另起一个服务：手机/桌面已经有一条 TLS 连接打到中继
 * （`wss://<relay>:9443`，端口对公网开放、证书已受信）。把账号接口做成同一个监听上的
 * HTTP 路径 `/acct/*`，就**不需要开新端口、不需要动阿里云安全组、不需要第二套证书**。
 *
 * 设计要点（2026-11-05，用户需求：多台主机，登录后同步个人配置）：
 *
 * 1. **服务器只见密文**。同步包由客户端用 `PBKDF2(密码, kdfSalt)` 派生的 AES-256-GCM
 *    密钥加密后上传；服务器只存 base64 密文，永远拿不到设备令牌与主机公钥。
 * 2. 密码仍然要在服务端**可验证**（这是登录），所以另存一份 scrypt 哈希。
 *    同一密码、两个用途：`kdfSalt` 给客户端派生加密密钥，scrypt 给服务器验证身份。
 * 3. 账号标识：手机号或邮箱同一个输入框（规范化后做 key，避免 +86/空格/大小写差异）。
 * 4. 令牌：登录发 32 字节随机串，只存 sha256；有效期 30 天，单账号最多 8 个（旧的自动淘汰）。
 * 5. 存储：`<dir>/users.json` + `<dir>/blobs/<accountId>.json`，全部原子写（tmp + rename）。
 *
 * 纯 Node（无第三方依赖），便于在中继那个极简运行时里跑。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 同步包上限（base64 后）：512KB 足够装下配对清单 + 设置，也挡住滥用。 */
const MAX_BLOB_BASE64 = 700_000;
/** 令牌有效期。 */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 单账号保留的令牌数（换机/重装会累积；旧的自然淘汰，不必让用户管理）。 */
const MAX_TOKENS = 8;
/** 同 IP 的登录/注册失败窗口与阈值（复用中继的封禁思路，简单滑动计数）。 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_FAILS = 10;

const scryptParams = { N: 16384, r: 8, p: 1 };

function nowIso() {
  return new Date().toISOString();
}

/** 原子写：先写 .tmp 再 rename（进程被 kill 也不会留下半截 JSON）。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * 规范化账号标识：手机号只留数字（去掉空格/横线/括号，保留开头 +），
 * 邮箱 trim + 小写。返回 null 表示不合法。
 */
export function normalizeIdentifier(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.includes("@")) {
    const email = value.toLowerCase();
    return /^[a-z0-9._%+=-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) && email.length <= 120 ? { kind: "email", key: email, display: email } : null;
  }
  const plus = value.startsWith("+");
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 6 || digits.length > 15) return null;
  return { kind: "phone", key: (plus ? "+" : "") + digits, display: (plus ? "+" : "") + digits };
}

function hashIdentifier(normalized) {
  return createHash("sha256").update(`mpi-acct:${normalized.key}`).digest("base64url");
}

function scryptHash(password, salt) {
  const derived = scryptSync(password, salt, 32, scryptParams);
  return derived.toString("base64url");
}

function verifyPassword(password, salt, expected) {
  try {
    const derived = scryptSync(password, salt, 32, scryptParams);
    const want = Buffer.from(expected, "base64url");
    return derived.length === want.length && timingSafeEqual(derived, want);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("base64url");
}

/** 账号库（单文件 + 内存缓存；量级是「个人几台设备」，不需要数据库）。 */
class AccountStore {
  constructor(dir) {
    this.dir = dir;
    this.usersFile = join(dir, "users.json");
    this.blobDir = join(dir, "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.users = readJson(this.usersFile, { accounts: {} });
    if (!this.users.accounts) this.users.accounts = {};
  }

  save() {
    writeJsonAtomic(this.usersFile, this.users);
  }

  findByIdentifier(normalized) {
    return this.users.accounts[hashIdentifier(normalized)] || null;
  }

  create({ normalized, password }) {
    const id = hashIdentifier(normalized);
    const salt = randomBytes(16).toString("base64");
    const kdfSalt = randomBytes(16).toString("base64");
    const account = {
      accountId: id,
      kind: normalized.kind,
      display: normalized.display,
      passwordSalt: salt,
      passwordHash: scryptHash(password, salt),
      // 客户端用它派生**加密密钥**；服务器自己也拿它去不了密文（加密密钥 = PBKDF2(密码, kdfSalt)）。
      kdfSalt,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      tokens: [],
    };
    this.users.accounts[id] = account;
    this.save();
    return account;
  }

  /** 校验密码并签发令牌；返回 null = 失败（调用方统一回「账号或密码不对」）。 */
  login(normalized, password) {
    const account = this.findByIdentifier(normalized);
    if (!account) return null;
    if (!verifyPassword(password, account.passwordSalt, account.passwordHash)) return null;
    const token = randomBytes(32).toString("base64url");
    const exp = Date.now() + TOKEN_TTL_MS;
    const tokens = (account.tokens || []).filter((entry) => entry.exp > Date.now());
    tokens.push({ h: hashToken(token), exp });
    account.tokens = tokens.slice(-MAX_TOKENS);
    account.updatedAt = nowIso();
    this.save();
    return { account, token, exp };
  }

  /** 令牌 → 账号（顺带清理过期令牌）。 */
  auth(token) {
    if (!token) return null;
    const h = hashToken(token);
    for (const account of Object.values(this.users.accounts)) {
      const entry = (account.tokens || []).find((item) => item.h === h);
      if (!entry) continue;
      if (entry.exp <= Date.now()) {
        account.tokens = account.tokens.filter((item) => item.h !== h);
        this.save();
        return null;
      }
      return account;
    }
    return null;
  }

  blobFile(accountId) {
    return join(this.blobDir, `${accountId}.json`);
  }

  readBlob(accountId) {
    return readJson(this.blobFile(accountId), null);
  }

  writeBlob(accountId, { ciphertext, revision }) {
    const current = this.readBlob(accountId);
    const record = {
      ciphertext,
      revision: Number.isFinite(revision) ? revision : (current?.revision || 0) + 1,
      updatedAt: nowIso(),
    };
    writeJsonAtomic(this.blobFile(accountId), record);
    return record;
  }
}

/** 简单的按 IP 滑动窗口（只用于登录/注册失败计数）。 */
class RateLimiter {
  constructor() {
    this.hits = new Map();
  }

  blocked(ip) {
    const entry = this.hits.get(ip);
    return Boolean(entry && entry.blockedUntil > Date.now());
  }

  fail(ip) {
    const now = Date.now();
    const entry = this.hits.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
    if (now - entry.firstAt > RATE_WINDOW_MS) {
      entry.count = 0;
      entry.firstAt = now;
    }
    entry.count += 1;
    if (entry.count >= RATE_MAX_FAILS) entry.blockedUntil = now + RATE_WINDOW_MS;
    this.hits.set(ip, entry);
  }

  reset(ip) {
    this.hits.delete(ip);
  }
}

/**
 * 挂到中继的 HTTP 路由上：返回 true 表示已处理。
 *
 * 路由（全部 JSON，HTTPS 由中继那层终结）：
 *   POST /acct/register {identifier, password}   → {accountId, kdfSalt, token, exp}
 *   POST /acct/login    {identifier, password}   → {accountId, kdfSalt, token, exp}
 *   PUT  /acct/blob     {ciphertext, revision?}  → {revision, updatedAt}      （Bearer）
 *   GET  /acct/blob                              → {ciphertext, revision, updatedAt}（Bearer）
 *   GET  /acct/me                                → {accountId, kind, display} （Bearer）
 */
export function createAccountApi(options) {
  const store = new AccountStore(options.dir);
  const limiter = new RateLimiter();
  const log = options.log || (() => {});
  const readBody = options.readBody;
  const clientIp = options.clientIp || (() => "unknown");

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const bearer = (req) => {
    const raw = String(req.headers?.authorization || "");
    const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
    return match ? match[1].trim() : "";
  };

  return async function handleAccountRequest(req, res) {
    const path = (req.url || "").split("?")[0];
    if (!path.startsWith("/acct/")) return false;
    const ip = clientIp(req);

    // ---- 注册 / 登录 ----
    if (path === "/acct/register" || path === "/acct/login") {
      if (req.method !== "POST") return send(res, 405, { error: "METHOD_NOT_ALLOWED" }), true;
      if (limiter.blocked(ip)) return send(res, 429, { error: "RATE_LIMITED" }), true;
      const body = await readBody(req, 8 * 1024);
      if (!body) return send(res, 400, { error: "BAD_JSON" }), true;
      const normalized = normalizeIdentifier(body.identifier);
      const password = typeof body.password === "string" ? body.password : "";
      if (!normalized) return limiter.fail(ip), send(res, 400, { error: "BAD_IDENTIFIER" }), true;
      if (password.length < 8 || password.length > 128) {
        return limiter.fail(ip), send(res, 400, { error: "BAD_PASSWORD", hint: "至少 8 位" }), true;
      }

      if (path === "/acct/register") {
        if (store.findByIdentifier(normalized)) return send(res, 409, { error: "ALREADY_EXISTS" }), true;
        const account = store.create({ normalized, password });
        const logged = store.login(normalized, password);
        limiter.reset(ip);
        log(`acct register ${normalized.kind} ${account.accountId.slice(0, 8)}`);
        return send(res, 200, { accountId: account.accountId, kdfSalt: account.kdfSalt, token: logged.token, exp: logged.exp }), true;
      }

      const result = store.login(normalized, password);
      if (!result) {
        limiter.fail(ip);
        log(`acct login failed ${normalized.kind} ip=${ip}`);
        return send(res, 401, { error: "BAD_CREDENTIALS" }), true;
      }
      limiter.reset(ip);
      log(`acct login ok ${result.account.accountId.slice(0, 8)}`);
      return send(res, 200, { accountId: result.account.accountId, kdfSalt: result.account.kdfSalt, token: result.token, exp: result.exp }), true;
    }

    // ---- 以下都需要令牌 ----
    const account = store.auth(bearer(req));
    if (!account) return send(res, 401, { error: "NOT_AUTHENTICATED" }), true;

    if (path === "/acct/me" && req.method === "GET") {
      return send(res, 200, { accountId: account.accountId, kind: account.kind, display: account.display }), true;
    }

    if (path === "/acct/blob") {
      if (req.method === "GET") {
        const record = store.readBlob(account.accountId);
        return send(res, 200, record ? { ciphertext: record.ciphertext, revision: record.revision, updatedAt: record.updatedAt } : { ciphertext: null, revision: 0 }), true;
      }
      if (req.method === "PUT" || req.method === "POST") {
        const body = await readBody(req, MAX_BLOB_BASE64 + 4096);
        if (!body) return send(res, 400, { error: "BAD_JSON" }), true;
        const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
        if (!ciphertext) return send(res, 400, { error: "EMPTY_BLOB" }), true;
        if (ciphertext.length > MAX_BLOB_BASE64) return send(res, 413, { error: "TOO_LARGE" }), true;
        const record = store.writeBlob(account.accountId, { ciphertext, revision: Number(body.revision) });
        log(`acct blob saved ${account.accountId.slice(0, 8)} bytes=${ciphertext.length} rev=${record.revision}`);
        return send(res, 200, { revision: record.revision, updatedAt: record.updatedAt }), true;
      }
      return send(res, 405, { error: "METHOD_NOT_ALLOWED" }), true;
    }

    return send(res, 404, { error: "NOT_FOUND" }), true;
  };
}
