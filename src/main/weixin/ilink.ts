/**
 * Minimal client for Tencent's iLink Bot API (个人微信 bot channel, gray release).
 *
 * Protocol reference: https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
 * (MIT-licensed; this is a self-contained re-implementation scoped to what the
 * MPI messaging module needs — QR login + text messages + typing indicator.)
 *
 * Transport notes:
 * - All bot API calls are JSON over HTTPS, long-poll based → NO public endpoint needed.
 * - QR requests always start at FIXED_BASE_URL; after confirmation the server may
 *   return a different `baseurl` (IDC redirect) which must be used for bot calls.
 * - uint64 ids (message_id / msg_id / svr_id) exceed Number.MAX_SAFE_INTEGER and are
 *   quoted to strings before JSON.parse (parseWeixinApiJson).
 */
import crypto from "node:crypto";

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
/** bot_type for this channel build (personal WeChat bot onboarding). */
export const ILINK_BOT_TYPE = "3";
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;

/** iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP, sent as decimal string. */
function buildClientVersion(major: number, minor: number, patch: number): string {
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = buildClientVersion(1, 0, 0);
/** Self-declared upstream identity (UA-style, observability only). */
const BOT_AGENT = "MPI/1.0";
const CHANNEL_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Wire types (subset of the protocol)
// ---------------------------------------------------------------------------

export interface QrCodeResponse {
  qrcode: string;
  /** URL to render as a QR code and scan with mobile WeChat. */
  qrcode_img_content: string;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "need_verifycode"
  | "verify_code_blocked"
  | "scaned_but_redirect"
  | "binded_redirect";

export interface QrStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  /** Bot API base URL to use after confirmation (may differ from FIXED_BASE_URL). */
  baseurl?: string;
  /** The user id of the person who scanned. */
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface TextItem {
  text?: string;
}
export interface MediaItemStub {
  media?: unknown;
  [key: string]: unknown;
}
export interface MessageItem {
  type?: number; // 1=text 2=image 3=voice 4=file 5=video
  text_item?: TextItem;
  image_item?: MediaItemStub;
  voice_item?: MediaItemStub & { text?: string };
  file_item?: MediaItemStub & { file_name?: string };
  video_item?: MediaItemStub;
}

export interface WeixinMessage {
  seq?: number;
  /** uint64 on the wire — parsed losslessly as a string. */
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  /** 1 = user, 2 = bot. */
  message_type?: number;
  /** 0 new / 1 generating / 2 finished. */
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  /** e.g. -14 = session/token expired (re-login required). */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResponse {
  message_id?: string;
  ret?: number;
  errmsg?: string;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function buildBaseInfo(): Record<string, unknown> {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

/** X-WECHAT-UIN header: random uint32 → decimal string → base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function httpJson(params: {
  baseUrl: string;
  endpoint: string;
  method?: "GET" | "POST";
  body?: string;
  token?: string;
  timeoutMs?: number;
  label: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const method = params.method ?? "POST";
  // GET (QR status polling) uses only the app headers — no auth/Content-Type.
  const headers = method === "GET" ? commonHeaders() : authHeaders(params.token);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (params.timeoutMs && params.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), params.timeoutMs);
  }
  // External abort (channel stop / login cancel) cancels the in-flight request.
  const onExternalAbort = () => controller.abort();
  if (params.abortSignal) {
    if (params.abortSignal.aborted) controller.abort();
    else params.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      ...(method === "POST" && params.body !== undefined ? { body: params.body } : {}),
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (!res.ok) throw new Error(`${params.label} HTTP ${res.status}: ${rawText.slice(0, 300)}`);
    return rawText;
  } finally {
    if (timer) clearTimeout(timer);
    params.abortSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Quotes uint64 id fields before JSON.parse so they survive as strings.
 * Ported from the reference implementation (only rewrites object properties,
 * never text inside JSON string values).
 */
const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

export function parseWeixinApiJson<T>(rawText: string): T {
  let output = "";
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }
    const stringStart = index;
    index++;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? "")) cursor++;
    if (rawText[cursor] !== ":") continue;

    let key: unknown;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (/\s/.test(rawText[cursor] ?? "")) {
      output += rawText[cursor++];
    }
    const numberStart = cursor;
    if (rawText[cursor] === "-") cursor++;
    while (/\d/.test(rawText[cursor] ?? "")) cursor++;
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === "-")) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output) as T;
}

// ---------------------------------------------------------------------------
// QR login
// ---------------------------------------------------------------------------

/** Request a fresh onboarding QR code. */
export async function fetchQrCode(localTokenList: string[] = []): Promise<QrCodeResponse> {
  const rawText = await httpJson({
    baseUrl: FIXED_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(ILINK_BOT_TYPE)}`,
    body: JSON.stringify({ local_token_list: localTokenList }),
    timeoutMs: API_TIMEOUT_MS,
    label: "fetchQrCode",
  });
  return JSON.parse(rawText) as QrCodeResponse;
}

/**
 * Long-poll the QR status. Client-side timeout / network errors resolve to
 * {status:"wait"} so callers can simply keep polling (normal control flow).
 */
export async function pollQrStatus(
  baseUrl: string,
  qrcode: string,
  verifyCode?: string,
  abortSignal?: AbortSignal,
): Promise<QrStatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    const rawText = await httpJson({
      baseUrl,
      endpoint,
      method: "GET",
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQrStatus",
      abortSignal,
    });
    return JSON.parse(rawText) as QrStatusResponse;
  } catch (err) {
    if (abortSignal?.aborted) throw err; // real cancellation — propagate
    console.warn(`[weixin] pollQrStatus transient error, treating as wait:`, err instanceof Error ? err.message : err);
    return { status: "wait" };
  }
}

// ---------------------------------------------------------------------------
// Bot API (requires bot_token)
// ---------------------------------------------------------------------------

/** Long-poll for inbound messages. Client timeout returns an empty response. */
export async function getUpdates(params: {
  baseUrl: string;
  token: string;
  getUpdatesBuf?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<GetUpdatesResponse> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await httpJson({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({ get_updates_buf: params.getUpdatesBuf ?? "", base_info: buildBaseInfo() }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
      abortSignal: params.abortSignal,
    });
    return parseWeixinApiJson<GetUpdatesResponse>(rawText);
  } catch (err) {
    if (params.abortSignal?.aborted) throw err;
    // Client-side long-poll timeout is normal — the caller just retries.
    console.debug(`[weixin] getUpdates timed out after ${timeout}ms, retrying`);
    return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
  }
}

/** Send a plain text message to a user (p2p). */
export async function sendTextMessage(params: {
  baseUrl: string;
  token: string;
  toUserId: string;
  text: string;
  contextToken?: string;
}): Promise<SendMessageResponse> {
  const clientId = `mpi-${crypto.randomUUID()}`;
  const rawText = await httpJson({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: params.toUserId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [{ type: 1, text_item: { text: params.text } }],
        ...(params.contextToken ? { context_token: params.contextToken } : {}),
      },
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: API_TIMEOUT_MS,
    label: "sendTextMessage",
  });
  const resp = parseWeixinApiJson<SendMessageResponse>(rawText);
  if (resp.ret && resp.ret !== 0) throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  return resp;
}

/** Fetch the typing ticket for a user (best-effort). */
export async function getTypingTicket(params: {
  baseUrl: string;
  token: string;
  userId: string;
  contextToken?: string;
}): Promise<string | null> {
  try {
    const rawText = await httpJson({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getconfig",
      body: JSON.stringify({
        ilink_user_id: params.userId,
        ...(params.contextToken ? { context_token: params.contextToken } : {}),
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
      label: "getTypingTicket",
    });
    const resp = JSON.parse(rawText) as { ret?: number; typing_ticket?: string };
    return resp.ret === 0 && typeof resp.typing_ticket === "string" ? resp.typing_ticket : null;
  } catch (err) {
    console.debug("[weixin] getTypingTicket failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Show/cancel the typing indicator (best-effort). status: 1=typing, 2=cancel. */
export async function sendTyping(params: {
  baseUrl: string;
  token: string;
  userId: string;
  ticket: string;
  status: 1 | 2;
}): Promise<void> {
  try {
    await httpJson({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({
        ilink_user_id: params.userId,
        typing_ticket: params.ticket,
        status: params.status,
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
      label: "sendTyping",
    });
  } catch (err) {
    console.debug("[weixin] sendTyping failed:", err instanceof Error ? err.message : err);
  }
}

/** Tell the backend this client started/stopped (best-effort lifecycle pings). */
export async function notifyLifecycle(params: { baseUrl: string; token: string; start: boolean }): Promise<void> {
  try {
    await httpJson({
      baseUrl: params.baseUrl,
      endpoint: params.start ? "ilink/bot/msg/notifystart" : "ilink/bot/msg/notifystop",
      body: JSON.stringify({ base_info: buildBaseInfo() }),
      token: params.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
      label: params.start ? "notifyStart" : "notifyStop",
    });
  } catch (err) {
    console.debug(`[weixin] notify${params.start ? "Start" : "Stop"} failed:`, err instanceof Error ? err.message : err);
  }
}
