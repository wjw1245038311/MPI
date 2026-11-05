/**
 * 网页版（PWA）的账号与配置同步。
 *
 * 与手机端（Kotlin）、桌面端（Electron）**同一套协议**：`/acct/*` + 客户端加密。
 * 密文布局必须是 `base64(iv[12] ‖ AES-256-GCM 密文 ‖ tag[16])`，密钥 =
 * `PBKDF2-SHA256(密码, kdfSalt, 210_000)`——三端能互相解开同一个同步包，这一点由
 * `test-account-pwa.mjs` 对着 Node 侧的实现交叉验证。
 *
 * 浏览器里存什么：账号会话（token）与派生密钥放 localStorage。它们是「能解同步包的东西」，
 * 但 PWA 本来就把 deviceToken 之类放在 IndexedDB 里（同一个源），风险面没有变大；
 * 换设备/清站点数据后重新登录即可恢复。
 */
import type { KeyStore, PairingRecord } from "./keystore";
import { b64FromBytes, bytesFromB64 } from "./b64";

export const ACCOUNT_SYNC_VERSION = 1;
const PBKDF2_ITERATIONS = 210_000;
const IV_BYTES = 12;
const STORAGE_KEY = "mpi.account.v1";
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const TOMBSTONE_MAX = 200;

export interface SyncTombstone {
  hostId: string;
  at: number;
}

export interface SyncPayload {
  version: number;
  updatedAt: number;
  pairings: PairingRecord[];
  deleted?: SyncTombstone[];
  settings?: Record<string, string>;
}

export interface AccountSessionState {
  identifier: string;
  accountId: string;
  kdfSalt: string;
  token: string;
  exp: number;
  /** 派生密钥（base64）。 */
  keyB64: string;
  lastSyncAt: number;
  revision: number;
  base: string;
  tombstones: SyncTombstone[];
}

// ---------------------------------------------------------------- 加密

const b64encode = b64FromBytes;
const b64decode = bytesFromB64;

export async function deriveAccountKey(password: string, kdfSaltB64: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password) as unknown as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: b64decode(kdfSaltB64) as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

export async function sealPayload(key: Uint8Array, plaintext: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cryptoKey = await crypto.subtle.importKey("raw", key as unknown as BufferSource, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, cryptoKey, plaintext as unknown as BufferSource));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return b64encode(out);
}

/** 解不开（密码不对/被篡改/格式坏）返回 null，不抛。 */
export async function openPayload(key: Uint8Array, payloadB64: string): Promise<Uint8Array | null> {
  try {
    const raw = b64decode(payloadB64);
    if (raw.length <= IV_BYTES + 16) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const body = raw.subarray(IV_BYTES);
    const cryptoKey = await crypto.subtle.importKey("raw", key as unknown as BufferSource, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, cryptoKey, body as unknown as BufferSource));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 合并

/** 墓碑合并：同 hostId 取较新那条，丢掉过期的（与两端实现一致）。 */
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

/** 墓碑生效判据：删除时刻 >= 配对时刻（删了又重配的不能被旧墓碑删掉）。 */
export function applyTombstones(pairings: PairingRecord[], tombstones: SyncTombstone[]): PairingRecord[] {
  if (!tombstones.length) return pairings;
  const removedAt = new Map(tombstones.map((stone) => [stone.hostId, stone.at]));
  return pairings.filter((record) => {
    const at = removedAt.get(record.hostId);
    return at === undefined ? true : at < record.pairedAt;
  });
}

export function mergePairings(local: PairingRecord[], remote: PairingRecord[]): PairingRecord[] {
  const known = new Set(local.map((record) => record.hostId));
  return [...local, ...remote.filter((record) => !known.has(record.hostId))];
}

/** 地址：只认 wss，公网优先（内网地址换网络时必然不通）。 */
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
  const isPrivate = (base: string) => {
    const host = base.replace(/^https:\/\//i, "").split(/[:/]/)[0].toLowerCase();
    if (host === "localhost" || host.endsWith(".local")) return true;
    return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  };
  return out.sort((a, b) => Number(isPrivate(a)) - Number(isPrivate(b)));
}

// ---------------------------------------------------------------- 本地状态

export function loadAccountState(): AccountSessionState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AccountSessionState;
    return parsed?.token && parsed?.keyB64 ? parsed : null;
  } catch {
    return null;
  }
}

export function saveAccountState(state: AccountSessionState | null): void {
  if (!state) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------- HTTP

async function callJson(base: string, path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const error = new Error(errorText(res.status, json?.error));
    (error as Error & { apiError?: boolean }).apiError = true;
    throw error;
  }
  return json;
}

function errorText(status: number, code?: string): string {
  switch (code) {
    case "BAD_IDENTIFIER":
      return "账号格式不对（手机号或邮箱）";
    case "BAD_PASSWORD":
      return "密码至少 8 位";
    case "ALREADY_EXISTS":
      return "这个账号已经注册过了，请直接登录";
    case "BAD_CREDENTIALS":
      return "账号或密码不对";
    case "BAD_CODE":
      return "验证码不对或已过期";
    case "CODE_TOO_SOON":
      return "验证码刚发过，请 1 分钟后再试";
    case "SMS_PHONE_ONLY":
      return "验证码登录只支持手机号";
    case "RATE_LIMITED":
      return "尝试太频繁，请稍后再试";
    case "NOT_AUTHENTICATED":
      return "登录已失效，请重新登录";
    default:
      return `账号服务返回 ${status}`;
  }
}

export async function accountSendCode(base: string, identifier: string): Promise<string | null> {
  const json = await callJson(base, "/acct/code", { method: "POST", body: { identifier: identifier.trim() } });
  return typeof json?.devCode === "string" && json.devCode ? String(json.devCode) : null;
}

export async function accountSignIn(
  base: string,
  input: { identifier: string; password?: string; code?: string; register?: boolean },
): Promise<{ accountId: string; kdfSalt: string; token: string; exp: number }> {
  const json = await callJson(base, input.register ? "/acct/register" : "/acct/login", {
    method: "POST",
    body: {
      identifier: input.identifier.trim(),
      ...(input.password ? { password: input.password } : {}),
      ...(input.code ? { code: input.code } : {}),
    },
  });
  if (!json?.token) throw new Error("账号服务没有返回令牌");
  return { accountId: json.accountId, kdfSalt: json.kdfSalt, token: json.token, exp: Number(json.exp || 0) };
}

export async function accountGetBlob(base: string, token: string) {
  return (await callJson(base, "/acct/blob", { token })) as { ciphertext: string | null; revision: number };
}

export async function accountPutBlob(base: string, token: string, ciphertext: string, revision: number) {
  return (await callJson(base, "/acct/blob", { method: "PUT", token, body: { ciphertext, revision } })) as {
    revision: number;
  };
}

/**
 * 逐条基地址尝试：网络错误换下一条，业务错误（apiError）直接抛。
 *
 * 真机踩过：候选是「局域网优先」，而设备在另一个网络时那条永远连不上。
 */
export async function withAccountBase<T>(bases: string[], fn: (base: string) => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (const base of bases) {
    try {
      return await fn(base);
    } catch (error) {
      if ((error as { apiError?: boolean })?.apiError) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("连不上账号服务器");
}

/** 一次完整同步：拉密文 → 解密 → 墓碑/配对/设置本地优先合并 → 写回本地 → 上传。 */
export async function syncAccount(
  store: KeyStore,
  state: AccountSessionState,
): Promise<{ state: AccountSessionState; pairings: PairingRecord[] }> {
  const key = b64decode(state.keyB64);
  const remote = await withAccountBase([state.base], (base) => accountGetBlob(base, state.token));
  const ciphertext = remote.ciphertext;
  const remotePayload: SyncPayload | null = ciphertext
    ? await (async () => {
        const opened = await openPayload(key, ciphertext);
        if (!opened) return null;
        try {
          return JSON.parse(new TextDecoder().decode(opened)) as SyncPayload;
        } catch {
          return null;
        }
      })()
    : null;

  const tombstones = mergeTombstones(state.tombstones || [], remotePayload?.deleted || []);
  const localPairings = applyTombstones(await store.listPairings(), tombstones);
  const merged = mergePairings(localPairings, remotePayload?.pairings || []);
  // 本地已删掉的（被墓碑命中）也要从 IndexedDB 里清掉。
  const keep = new Set(merged.map((record) => record.hostId));
  for (const record of await store.listPairings()) {
    if (!keep.has(record.hostId)) await store.deletePairing(record.hostId);
  }
  for (const record of merged) {
    if (!localPairings.some((item) => item.hostId === record.hostId)) await store.savePairing(record);
  }

  const payload: SyncPayload = {
    version: ACCOUNT_SYNC_VERSION,
    updatedAt: Date.now(),
    pairings: merged,
    deleted: tombstones,
  };
  const sealed = await sealPayload(key, new TextEncoder().encode(JSON.stringify(payload)));
  const written = await withAccountBase([state.base], (base) =>
    accountPutBlob(base, state.token, sealed, remote.revision),
  );
  const next: AccountSessionState = { ...state, tombstones, lastSyncAt: Date.now(), revision: Number(written.revision || 0) };
  saveAccountState(next);
  return { state: next, pairings: merged };
}
