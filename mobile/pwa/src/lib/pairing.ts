/**
 * Pairing flow for the mobile PWA (docs/MOBILE-DESIGN.md §4.2, stage S2).
 *
 * mpi://pair link → WSS to relay → pair.request → host pair.challenge →
 * Ed25519-signed pair.hello → (desktop approves) → pair.accepted + deviceToken.
 * E2E X25519/AES-GCM key material arrives in S3; the handshake itself is final.
 */
// Relative (not an alias) so node-based tests can import this module directly.
// src/lib → pwa → mobile → shared
import { makeEnvelope } from "../../../shared/protocol";
import { deviceProofText, hostIdFor, hostProofText, verifyHostSignature, type DeviceIdentity } from "./device-identity";
import { E2E_BINARY_CAP, decodeBinaryFrame, encodeBinaryFrame, supportsBinaryFrames } from "./e2e-binary";
import {
  deriveAesKeyRaw,
  decryptFrame as e2eDecrypt,
  decryptFrameRaw,
  encryptFrameRaw,
  encryptFrame as e2eEncrypt,
  importAesKey,
  x25519SharedSecretRaw,
  type E2EFrame,
} from "./e2e-crypto";
import type { RelayClient } from "./relay-client";

export interface PairingPayload {
  hostId: string;
  fingerprint?: string;
  hostPublicKeyPem?: string;
  /** Relay WSS endpoint embedded by the desktop (S3); S2 links may carry it too. */
  relayUrl?: string;
  /** S3：**有序地址列表**（局域网 → 主 → 备）——客户端按序选路（S4）；旧客户端只读 relayUrl。 */
  relayUrls?: string[];
  ticket: string;
  expiresAt: number;
  protocol?: number;
  /** 桌面机器名（多设备列表用来区分主机）；旧版桌面生成的载荷里没有。 */
  hostName?: string;
}

export type PairingStage = "connecting" | "waiting-challenge" | "waiting-approval" | "approved" | "error";

/** Accepts "mpi://pair?payload=<b64url>" or a bare b64url payload. */
/** 从完整 https 配对链接（https://<relay>/#pair=<b64> 或 ?pair=）里提取 payload；没有则 null。 */
function pairParamFromUrl(text: string): string | null {
  const hashIndex = text.indexOf("#");
  if (hashIndex >= 0) {
    const fromHash = new URLSearchParams(text.slice(hashIndex + 1)).get("pair");
    if (fromHash) return fromHash;
  }
  const queryIndex = text.indexOf("?");
  if (queryIndex >= 0) {
    const fromQuery = new URLSearchParams(text.slice(queryIndex + 1).split("#")[0]).get("pair");
    if (fromQuery) return fromQuery;
  }
  return null;
}

export function parsePairingLink(input: string): PairingPayload {
  let raw = input.trim();
  if (raw.startsWith("mpi://")) {
    const queryIndex = raw.indexOf("?");
    const params = new URLSearchParams(queryIndex >= 0 ? raw.slice(queryIndex + 1) : "");
    raw = params.get("payload") || "";
  } else {
    // 桌面端「复制链接」给的是完整 https 链接（扫码用）——粘贴框里也直接接受，提取 payload。
    const extracted = pairParamFromUrl(raw);
    if (extracted) raw = extracted;
  }
  if (!raw) throw new Error("missing pairing payload");
  let json: unknown;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    json = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    throw new Error("invalid pairing link");
  }
  if (!json || typeof json !== "object") throw new Error("invalid pairing payload");
  const value = json as Record<string, unknown>;
  if (typeof value.hostId !== "string" || !value.hostId) throw new Error("pairing payload missing hostId");
  if (typeof value.ticket !== "string" || !value.ticket) throw new Error("pairing payload missing ticket");
  return {
    hostId: value.hostId,
    fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : undefined,    hostPublicKeyPem: typeof value.hostPublicKeyPem === "string" ? value.hostPublicKeyPem : undefined,
    relayUrl: typeof value.relayUrl === "string" && value.relayUrl ? value.relayUrl : undefined,
    relayUrls: Array.isArray(value.relayUrls)
      ? value.relayUrls.filter((url): url is string => typeof url === "string" && !!url.trim())
      : undefined,
    ticket: value.ticket,
    expiresAt: Number.isSafeInteger(value.expiresAt) ? (value.expiresAt as number) : 0,
    protocol: Number.isSafeInteger(value.protocol) ? (value.protocol as number) : undefined,
    hostName: typeof value.hostName === "string" && value.hostName ? value.hostName : undefined,
  };
}

/** Resolve on the first frame matching `pred`; reject on relay/host errors / timeout. */
function awaitFrameOrError(
  client: RelayClient,
  pred: (frame: Record<string, unknown>) => boolean,
  what: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const off = client.onFrame((frame) => {
      if (frame.type === "relay.error") {
        cleanup();
        reject(new Error(`relay error: ${String(frame.code ?? "unknown")}`));
      } else if (frame.type === "error" && frame.error) {
        // Protocol-level error envelope from the host (e.g. AUTH_REQUIRED).
        const err = frame.error as Record<string, unknown>;
        cleanup();
        reject(new Error(`host error: ${String(err.code ?? "")} ${String(err.message ?? "")}`.trim()));
      } else if (pred(frame)) {
        cleanup();
        resolve(frame);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${what}`));
    }, timeoutMs);
    function cleanup() {
      off();
      clearTimeout(timer);
    }
  });
}

async function waitForOpen(client: RelayClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!client.isOpen()) {
    if (Date.now() > deadline) throw new Error("timed out connecting to relay");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface PairingResult {
  deviceToken: string;
  /** Host X25519 public key (b64url) — persist it; the session key is re-derived
   * locally on every reconnect, no renegotiation needed. */
  hostX25519PubB64u: string;
  /** 主机身份公钥（SPKI PEM）——**必须落盘**（pinning）：下次重连用它校验对端没换身份。 */
  hostPublicKeyPem: string;
}

/**
 * 主机身份绑定（2026-10-19 审计，docs/SECURITY-AUDIT-2026-10-19-RELAY-MITM.md §2）。
 *
 * 只验「签名与对端递来的公钥自洽」是不够的：中继可以递**自己的**公钥并自签，手机照样通过。
 * 所以必须补两道：
 *   1. `sha256(主机公钥) === 票里的 hostId` —— hostId 来自扫码（带外），中继改不了；
 *   2. 与本地已配对记录里的身份公钥比对 —— 一旦 pin 过，换公钥一律拒。
 *
 * 旧记录没有 pin、旧票没有 `hostPublicKeyPem` → 对应检查跳过（仅第 1 道必须过）。
 * 校验通过后调用方应把本次的 `hostPublicKeyPem` 写回记录，完成 pinning。
 */
export function checkHostIdentity(args: {
  /** 票里的 hostId（= 主机身份公钥哈希），来自扫码这一带外通道。 */
  hostId: string;
  /** 对端在 pair.challenge 里递来的身份公钥。 */
  hostPublicKeyPem: string;
  /** 票里自带的主机身份公钥（新版票才有）——比哈希比对更强，有就必须一致。 */
  ticketHostPublicKeyPem?: string;
  /** 本地已配对记录里的身份公钥（pinning）。 */
  pinnedHostPublicKeyPem?: string;
}): void {
  const { hostId, hostPublicKeyPem, ticketHostPublicKeyPem, pinnedHostPublicKeyPem } = args;
  if (!hostPublicKeyPem) throw new Error("pair.challenge 缺少主机身份公钥（可能存在中间人）——已拒绝");
  if (ticketHostPublicKeyPem && ticketHostPublicKeyPem !== hostPublicKeyPem) {
    throw new Error("主机身份公钥与配对票不符（可能存在中间人）——已拒绝建立会话");
  }
  if (hostIdFor(hostPublicKeyPem) !== hostId) {
    throw new Error("主机身份公钥与配对票里的 hostId 不符（可能存在中间人）——已拒绝建立会话，请重新扫码");
  }
  if (pinnedHostPublicKeyPem && pinnedHostPublicKeyPem !== hostPublicKeyPem) {
    throw new Error("主机身份公钥已变化（可能存在中间人）——已拒绝建立会话，请重新扫码配对");
  }
}

/** Answer a pair.challenge with a signed pair.hello and wait for pair.accepted. */
async function answerChallenge(
  client: RelayClient,
  hostId: string,
  identity: DeviceIdentity,
  deviceName: string,
  ticket: string,
  acceptedTimeoutMs: number,
  onStage?: (stage: PairingStage) => void,
  /** 身份绑定参数：票里的公钥 + 本地 pin（见 checkHostIdentity）。 */
  binding?: { ticketHostPublicKeyPem?: string; pinnedHostPublicKeyPem?: string },
): Promise<PairingResult> {
  const challenge = await awaitFrameOrError(client, (f) => f.type === "pair.challenge", "pair.challenge", 20_000);
  const cp = (challenge.payload || {}) as Record<string, unknown>;
  const connectionId = typeof cp.connectionId === "string" ? cp.connectionId : "";
  const challengeValue = typeof cp.challenge === "string" ? cp.challenge : "";
  if (!connectionId || !challengeValue) throw new Error("malformed pair.challenge");

  onStage?.("waiting-approval");
  // v2（见 docs/RELAY-SHARING.md §9）：先验主机身份与它的 E2E 公钥，再签自己的（含自己的公钥）。
  const hostPublicKeyPem = String(cp.hostPublicKeyPem ?? "");
  const hostSignature = String(cp.signature ?? "");
  const hostX25519Pub = String(cp.hostX25519Pub ?? "");
  // 先做身份绑定：公钥必须能哈希回票里的 hostId，且与本地 pin 一致。
  checkHostIdentity({
    hostId,
    hostPublicKeyPem,
    ticketHostPublicKeyPem: binding?.ticketHostPublicKeyPem,
    pinnedHostPublicKeyPem: binding?.pinnedHostPublicKeyPem,
  });
  if (!hostX25519Pub || !verifyHostSignature(hostPublicKeyPem, hostProofText(hostId, connectionId, challengeValue, hostX25519Pub), hostSignature)) {
    throw new Error("主机身份校验失败（可能存在中间人）——请确认连接的是你自己的桌面端");
  }
  const signedText = deviceProofText(hostId, connectionId, challengeValue, identity.deviceId, identity.x25519PubB64u);
  client.send(
    makeEnvelope("pair.hello", String(challenge.sessionId), {
      deviceId: identity.deviceId,
      deviceName,
      publicKeyPem: identity.publicKeyPem,
      signature: identity.signText(signedText),
      ticket,
      // E2E (S3): the host derives the session key from this on pair.hello.
      x25519Pub: identity.x25519PubB64u,
      // 能力协商：本端支持二进制 E2E 帧（去 base64 的 33% 膨胀，见 e2e-binary.ts）
      caps: [E2E_BINARY_CAP],
    }),
  );

  // Trusted devices are accepted immediately; new ones wait for the desktop user.
  const accepted = await awaitFrameOrError(client, (f) => f.type === "pair.accepted", "pair.accepted", acceptedTimeoutMs);
  const ap = (accepted.payload || {}) as Record<string, unknown>;
  const deviceToken = typeof ap.deviceToken === "string" ? ap.deviceToken : "";
  const hostX25519PubB64u = typeof ap.x25519Pub === "string" ? ap.x25519Pub : "";
  // 配对票里的公钥必须就是**被主机签名覆盖**的那一个；否则就是中继在替换公钥（MITM）。
  if (hostX25519PubB64u && hostX25519PubB64u !== hostX25519Pub) {
    throw new Error("主机公钥与签名不符（可能存在中间人）——已拒绝建立会话");
  }

  // E2E session: X25519 → HKDF-SHA256 → AES-256-GCM (§4.2). Deterministic, so a
  // reconnect re-auth (fresh pair.accepted) re-installs the same key.
  if (hostX25519PubB64u) {
    const shared = x25519SharedSecretRaw(identity.x25519PrivB64u, hostX25519PubB64u);
    const cryptoKey = await importAesKey(deriveAesKeyRaw(shared, hostId, identity.deviceId));
    // Adapter between RelayClient.FrameCrypto and the concrete E2EFrame types.
    // 两端都声明了 e2e-bin 才切二进制；否则继续 JSON（老主机/老端行为不变）。
    const binary = supportsBinaryFrames(ap.caps);
    client.setFrameCrypto({
      binary,
      encrypt: async (plain) => (await e2eEncrypt(cryptoKey, plain)) as unknown as Record<string, unknown>,
      decrypt: (frame) => e2eDecrypt(cryptoKey, frame as Pick<E2EFrame, "n" | "c">),
      encryptBinary: async (plain) => {
        const { nonce, body } = await encryptFrameRaw(cryptoKey, plain);
        // 设备→主机：头部可空（中继会补 from）；空头部省字节。
        return encodeBinaryFrame({}, nonce, body);
      },
      decryptBinary: async (bytes) => {
        const decoded = decodeBinaryFrame(bytes);
        if (!decoded) throw new Error("invalid binary E2E frame");
        return decryptFrameRaw(cryptoKey, decoded.nonce, decoded.body);
      },
    });
  }
  return { deviceToken, hostX25519PubB64u, hostPublicKeyPem };
}

/** Run the full pairing handshake. Resolves with the stable deviceToken. */
export async function runPairing(
  client: RelayClient,
  payload: PairingPayload,
  identity: DeviceIdentity,
  deviceName: string,
  onStage?: (stage: PairingStage, detail?: string) => void,
): Promise<PairingResult> {
  const fail = (detail: string): never => {
    onStage?.("error", detail);
    throw new Error(detail);
  };

  client.connect();
  await waitForOpen(client, 10_000).catch(() => fail(`cannot reach relay (${client.getLastError() ?? "connection failed"})`));

  // First frame decides the socket role — must be pair.request.
  onStage?.("connecting");
  if (!client.pairRequest(payload.ticket, identity.deviceId, deviceName)) {
    return fail("failed to send pair.request");
  }

  onStage?.("waiting-challenge");
  const result = await answerChallenge(client, payload.hostId, identity, deviceName, payload.ticket, 5 * 60_000, (s) => onStage?.(s), {
    // 票里带身份公钥时直接按值比对（比哈希更强）；旧票只有 hostId，走哈希校验。
    ticketHostPublicKeyPem: payload.hostPublicKeyPem,
  }).catch((e: Error) => fail(e.message));
  onStage?.("approved");
  return result;
}

/** Re-auth an already-trusted device after (re)connect: the relay hello triggers a
 * fresh pair.challenge from the host; answer it and wait for pair.accepted. */
export async function reauthenticate(
  client: RelayClient,
  hostId: string,
  identity: DeviceIdentity,
  deviceName: string,
  /** 已配对记录里的主机身份公钥（pinning）；旧记录没有 → 只做 hostId 哈希校验。 */
  pinnedHostPublicKeyPem?: string,
): Promise<PairingResult> {
  return answerChallenge(client, hostId, identity, deviceName, "", 30_000, undefined, { pinnedHostPublicKeyPem });
}

/**
 * Keep an established session alive across mid-session socket drops: whenever the
 * socket opens again (initial connect included), redo the challenge handshake —
 * which also reinstalls E2E crypto. Attach AFTER setHelloCreds; returns cleanup.
 */
export function attachAutoReauth(
  client: RelayClient,
  hostId: string,
  identity: DeviceIdentity,
  deviceName: string,
  onReauth?: (result: PairingResult) => void,
  /** 已配对记录里的主机身份公钥（pinning）。 */
  pinnedHostPublicKeyPem?: string,
): () => void {
  let inFlight = false;
  const off = client.onState((state) => {
    if (state !== "open" || inFlight) return;
    inFlight = true;
    reauthenticate(client, hostId, identity, deviceName, pinnedHostPublicKeyPem)
      .then((result) => onReauth?.(result))
      .catch(() => { /* surfaced via UI error state; next open retries */ })
      .finally(() => {
        inFlight = false;
      });
  });
  return off;
}
