/**
 * 账号与个人配置同步（桌面端）——与手机端同一套协议（`/acct/*`，见 mobile/relay/account.mjs）。
 *
 * 为什么桌面也要同步（2026-11-05 用户需求：多台主机）：桌面是**主机**，它的身份文件
 * （`remote-identity.json`：hostId、私钥、HMAC 密钥、已配对设备清单）一旦丢，所有手机都得
 * 重新配对。换电脑/重装后能把这套身份恢复回来，是「换机不重配」的唯一办法。
 *
 * 加密与手机端**逐字节一致**（两份实现必须能互相解开）：
 *   密钥 = PBKDF2-SHA256(密码, kdfSalt, 210_000) → 32B
 *   密文 = base64( iv[12] ‖ AES-256-GCM(明文) )
 *
 * 服务器（自己的 ECS）只见密文；密码在服务端另存一份 scrypt 哈希用于登录校验。
 * 纯逻辑（加密/打包/合并/地址排序）与网络分离，便于单测。
 */
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

/** 与手机端/服务端一致：改这里就等于换协议。 */
export const ACCOUNT_SYNC_VERSION = 1;
const PBKDF2_ITERATIONS = 210_000;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const MAX_BLOB_BASE64 = 700_000;

// ---------------------------------------------------------------- 加密

/** 密码 + 服务端 kdfSalt → 32 字节 AES 密钥（与安卓 AcctCrypto.deriveKey 必须一致）。 */
export function deriveAccountKey(password: string, kdfSaltB64: string): Buffer {
  const salt = Buffer.from(kdfSaltB64, "base64");
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, "sha256");
}

/** 明文 → base64(iv ‖ ciphertext+tag)。 */
export function sealAccountPayload(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

/**
 * base64(iv ‖ ciphertext+tag) → 明文；密钥不对/被篡改返回 null（调用方当成「解不开」）。
 *
 * 注意布局与安卓端一致：**iv 在前、tag 在后**（GCM tag 是最后 16 字节），
 * 这样两边实现可以互相解开同一个同步包。
 */
export function openAccountPayload(key: Buffer, payloadB64: string): Buffer | null {
  try {
    const raw = Buffer.from(payloadB64, "base64");
    if (raw.length <= IV_BYTES + 16) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - 16);
    const body = raw.subarray(IV_BYTES, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 同步内容

/** 主机身份里**可携带**的部分（明文，只在加密后上传）。 */
export interface SyncIdentity {
  hostId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  hmacSecret: string;
  x25519PubB64u: string;
  x25519PrivB64u: string;
  /** 已配对设备：恢复后手机不用重新扫码。 */
  trustedDevices: unknown[];
}

/** 删除墓碑（与手机端同一结构）：hostId + 删除时刻。 */
export interface SyncTombstone {
  hostId: string;
  at: number;
}

export interface DesktopSyncPayload {
  version: number;
  updatedAt: number;
  /** 已删除的主机（墓碑）：桌面不维护主机列表，只负责**带上**它们，让手机端跟随删除。 */
  deleted?: SyncTombstone[];
  /** 主机身份（换机恢复 hostId 用）。 */
  identity?: SyncIdentity;
  /** 桌面设置白名单（语言 / 主题…）。 */
  settings?: Record<string, string>;
}

/** 这一版参与同步的桌面设置项（新增键要三端一起改）。 */
export const DESKTOP_SETTING_KEYS = new Set(["language", "theme"]);

export function buildDesktopPayload(input: {
  identity?: SyncIdentity | null;
  settings: Record<string, string>;
  now?: number;
}): DesktopSyncPayload {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.settings)) {
    if (DESKTOP_SETTING_KEYS.has(key)) settings[key] = String(value);
  }
  return {
    version: ACCOUNT_SYNC_VERSION,
    updatedAt: input.now ?? Date.now(),
    ...(input.identity ? { identity: input.identity } : {}),
    settings,
  };
}

/**
 * 合并策略：**本地优先**。
 *
 * - 身份：本机已有 `hostId` 且带已配对设备 → 保留本机（它是活的，覆盖等于把手机全踢下线）；
 *   本机是全新安装（没有身份文件）→ 用远端的。
 * - 设置：本地已有键为准，远端补缺。
 */
export function mergeDesktopPayload(
  local: DesktopSyncPayload,
  remote: DesktopSyncPayload | null,
): DesktopSyncPayload {
  if (!remote) return local;
  const settings = { ...(local.settings || {}) };
  for (const [key, value] of Object.entries(remote.settings || {})) {
    if (DESKTOP_SETTING_KEYS.has(key) && !(key in settings)) settings[key] = value;
  }
  return {
    version: ACCOUNT_SYNC_VERSION,
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
    identity: local.identity ?? remote.identity,
    settings,
    deleted: mergeTombstones(local.deleted || [], remote.deleted || []),
  };
}

/** 墓碑保留期（与手机端一致）：90 天足够所有设备都同步到。 */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const TOMBSTONE_MAX = 200;

/** 墓碑合并：同 hostId 取较新那条，丢掉过期的，按时间倒序截断。 */
export function mergeTombstones(
  local: SyncTombstone[],
  remote: SyncTombstone[],
  now: number = Date.now(),
): SyncTombstone[] {
  const newest = new Map<string, SyncTombstone>();
  for (const stone of [...local, ...remote]) {
    if (!stone?.hostId || typeof stone.at !== "number") continue;
    if (now - stone.at > TOMBSTONE_TTL_MS) continue;
    const kept = newest.get(stone.hostId);
    if (!kept || stone.at > kept.at) newest.set(stone.hostId, { hostId: stone.hostId, at: stone.at });
  }
  return [...newest.values()].sort((a, b) => b.at - a.at).slice(0, TOMBSTONE_MAX);
}

export function encodePayload(payload: DesktopSyncPayload): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

export function decodePayload(bytes: Buffer): DesktopSyncPayload | null {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as DesktopSyncPayload;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 地址

const PRIVATE_HOST = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/** 内网/本机地址：手机或本机换网络时它必然不通（真机踩过：连 10.215.35.72:9443 超时）。 */
export function isPrivateHostUrl(baseUrl: string): boolean {
  const host = String(baseUrl || "").replace(/^[a-z]+:\/\//i, "").split(/[:/]/)[0].toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan")) return true;
  return PRIVATE_HOST.test(host);
}

/**
 * 中继候选（ws/wss）→ 账号接口的 https 基地址，**公网优先**。
 *
 * 账号接口只在中继的 TLS 监听上（明文侧没有——密码不能裸奔），所以只认 `wss://`。
 */
export function accountBasesOf(candidates: string[]): string[] {
  const out: string[] = [];
  for (const raw of candidates || []) {
    const url = String(raw || "").trim();
    if (!/^wss:\/\//i.test(url)) continue;
    const hostPart = url.replace(/^wss:\/\//i, "").split("/")[0];
    if (!hostPart) continue;
    const base = `https://${hostPart}`;
    if (!out.includes(base)) out.push(base);
  }
  return out.sort((a, b) => Number(isPrivateHostUrl(a)) - Number(isPrivateHostUrl(b)));
}

// ---------------------------------------------------------------- HTTP

export interface AccountHttpOptions {
  /** 自签 CA 的 PEM（中继用的是 MPI Self-signed CA）。缺省用系统信任库。 */
  caPem?: string | null;
  timeoutMs?: number;
}

interface JsonResponse {
  status: number;
  json: any;
}

/** 一次 JSON 请求（https，可带自签 CA）；非 2xx 也返回 json，由调用方判读。 */
function requestJson(
  base: string,
  path: string,
  options: AccountHttpOptions & { method?: string; body?: unknown; token?: string } = {},
): Promise<JsonResponse> {
  const url = new URL(path, base);
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8");
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method: options.method || "GET",
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...(body ? { "content-length": String(body.length) } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        ...(options.caPem ? { ca: [options.caPem] } : {}),
        timeout: options.timeoutMs ?? 8000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 发送验证码；返回 dev 模式的码（服务端没配短信服务时直接回，便于自测）。 */
export async function accountSendCode(
  base: string,
  identifier: string,
  options: AccountHttpOptions = {},
): Promise<string | null> {
  const res = await requestJson(base, "/acct/code", {
    method: "POST",
    body: { identifier: identifier.trim() },
    ...options,
  });
  if (res.status !== 200) throw apiError(res.status, res.json?.error);
  return typeof res.json?.devCode === "string" && res.json.devCode ? String(res.json.devCode) : null;
}

export interface AccountSession {
  accountId: string;
  kdfSalt: string;
  token: string;
  exp: number;
  identifier: string;
}

/** 登录或注册；错误翻成中文文案（与手机端一致）。 */
export async function accountSignIn(
  base: string,
  input: { identifier: string; password?: string; code?: string; register: boolean },
  options: AccountHttpOptions = {},
): Promise<AccountSession> {
  const path = input.register ? "/acct/register" : "/acct/login";
  const res = await requestJson(base, path, {
    method: "POST",
    body: {
      identifier: input.identifier.trim(),
      ...(input.password ? { password: input.password } : {}),
      ...(input.code ? { code: input.code } : {}),
    },
    ...options,
  });
  if (res.status !== 200 || !res.json?.token) {
    throw apiError(res.status, res.json?.error);
  }
  return {
    accountId: String(res.json.accountId || ""),
    kdfSalt: String(res.json.kdfSalt || ""),
    token: String(res.json.token),
    exp: Number(res.json.exp || 0),
    identifier: input.identifier.trim(),
  };
}

export async function accountGetBlob(
  base: string,
  token: string,
  options: AccountHttpOptions = {},
): Promise<{ ciphertext: string | null; revision: number; updatedAt?: string }> {
  const res = await requestJson(base, "/acct/blob", { token, ...options });
  if (res.status !== 200) throw new Error(accountErrorText(res.status, res.json?.error));
  return {
    ciphertext: typeof res.json?.ciphertext === "string" ? res.json.ciphertext : null,
    revision: Number(res.json?.revision || 0),
    ...(typeof res.json?.updatedAt === "string" ? { updatedAt: res.json.updatedAt } : {}),
  };
}

export async function accountPutBlob(
  base: string,
  token: string,
  ciphertext: string,
  revision: number,
  options: AccountHttpOptions = {},
): Promise<{ revision: number; updatedAt?: string }> {
  if (ciphertext.length > MAX_BLOB_BASE64) throw new Error("同步包太大（上限约 500KB）");
  const res = await requestJson(base, "/acct/blob", {
    method: "PUT",
    token,
    body: { ciphertext, revision },
    ...options,
  });
  if (res.status !== 200) throw new Error(accountErrorText(res.status, res.json?.error));
  return {
    revision: Number(res.json?.revision || revision),
    ...(typeof res.json?.updatedAt === "string" ? { updatedAt: res.json.updatedAt } : {}),
  };
}

/** 从明文侧取中继的自签 CA（账号接口的 https 需要它）。 */
export async function fetchRelayCa(plainBase: string, timeoutMs = 4000): Promise<string | null> {
  try {
    const url = new URL("/mpi-selfsigned-ca.crt", plainBase);
    const raw = await new Promise<string>((resolve, reject) => {
      // 明文 http：这是 TOFU 的引导步骤（没有它就没有可信任的起点）。
      const mod = url.protocol === "https:" ? import("node:https") : import("node:http");
      void mod.then(({ request }) => {
        const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, timeout: timeoutMs }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk as Buffer));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        req.end();
      });
    });
    return raw.includes("BEGIN CERTIFICATE") ? raw : null;
  } catch {
    return null;
  }
}

/** HTTP 层的业务错误（4xx/5xx）：调用方不要拿它去试下一个基地址。 */
function apiError(status: number, code?: string): Error {
  const error = new Error(accountErrorText(status, code));
  error.name = "AccountApiError";
  return error;
}

function accountErrorText(status: number, code?: string): string {
  switch (code) {
    case "BAD_IDENTIFIER":
      return "账号格式不对（手机号或邮箱）";
    case "BAD_PASSWORD":
      return "密码至少 8 位";
    case "ALREADY_EXISTS":
      return "这个账号已经注册过了，请直接登录";
    case "BAD_CREDENTIALS":
      return "账号或密码不对";
    case "RATE_LIMITED":
      return "尝试太频繁，请稍后再试";
    case "CODE_TOO_SOON":
      return "验证码刚发过，请 1 分钟后再试";
    case "BAD_CODE":
      return "验证码不对或已过期";
    case "SMS_PHONE_ONLY":
      return "验证码登录只支持手机号";
    case "SMS_FAILED":
      return "短信发送失败，请稍后再试";
    case "TOO_LARGE":
      return "同步包太大（上限约 500KB）";
    case "NOT_AUTHENTICATED":
      return "登录已失效，请重新登录";
    default:
      return `账号服务返回 ${status}`;
  }
}

// ---------------------------------------------------------------- 本地状态

/**
 * 本地账号状态（`<userData>/account-sync.json`）。
 *
 * `keyB64` 是 PBKDF2 派生密钥：有了它才能解开同步包。文件由调用方用 safeStorage 加密后
 * 再落盘（见 ipc.ts），这里只管结构。
 */
export interface StoredAccount {
  identifier: string;
  accountId: string;
  kdfSalt: string;
  token: string;
  exp: number;
  keyB64: string;
  lastSyncAt: number;
  revision: number;
  base: string;
}

export function accountStateFile(userDataDir: string): string {
  return join(userDataDir, "account-sync.json");
}

export function readStoredAccount(userDataDir: string): StoredAccount | null {
  const file = accountStateFile(userDataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredAccount;
    return parsed && typeof parsed.token === "string" && typeof parsed.keyB64 === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredAccount(userDataDir: string, state: StoredAccount | null): void {
  writeFileSync(accountStateFile(userDataDir), state ? JSON.stringify(state, null, 2) : "{}", "utf8");
}

/** 账号标识的指纹（只用于日志，不落明文）。 */
export function identifierFingerprint(identifier: string): string {
  return createHash("sha256").update(identifier.trim().toLowerCase()).digest("base64url").slice(0, 8);
}
