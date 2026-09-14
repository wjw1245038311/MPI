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
import type { DeviceIdentity } from "./device-identity";
import type { RelayClient } from "./relay-client";

export interface PairingPayload {
  hostId: string;
  fingerprint?: string;
  hostPublicKeyPem?: string;
  /** Relay WSS endpoint embedded by the desktop (S3); S2 links may carry it too. */
  relayUrl?: string;
  ticket: string;
  expiresAt: number;
  protocol?: number;
}

export type PairingStage = "connecting" | "waiting-challenge" | "waiting-approval" | "approved" | "error";

/** Accepts "mpi://pair?payload=<b64url>" or a bare b64url payload. */
export function parsePairingLink(input: string): PairingPayload {
  let raw = input.trim();
  if (raw.startsWith("mpi://")) {
    const queryIndex = raw.indexOf("?");
    const params = new URLSearchParams(queryIndex >= 0 ? raw.slice(queryIndex + 1) : "");
    raw = params.get("payload") || "";
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
    fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : undefined,
    hostPublicKeyPem: typeof value.hostPublicKeyPem === "string" ? value.hostPublicKeyPem : undefined,
    relayUrl: typeof value.relayUrl === "string" && value.relayUrl ? value.relayUrl : undefined,
    ticket: value.ticket,
    expiresAt: Number.isSafeInteger(value.expiresAt) ? (value.expiresAt as number) : 0,
    protocol: Number.isSafeInteger(value.protocol) ? (value.protocol as number) : undefined,
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
): Promise<PairingResult> {
  const challenge = await awaitFrameOrError(client, (f) => f.type === "pair.challenge", "pair.challenge", 20_000);
  const cp = (challenge.payload || {}) as Record<string, unknown>;
  const connectionId = typeof cp.connectionId === "string" ? cp.connectionId : "";
  const challengeValue = typeof cp.challenge === "string" ? cp.challenge : "";
  if (!connectionId || !challengeValue) throw new Error("malformed pair.challenge");

  onStage?.("waiting-approval");
  const signedText = `mpi-remote-v1|${hostId}|${connectionId}|${challengeValue}|${identity.deviceId}`;
  client.send(
    makeEnvelope("pair.hello", String(challenge.sessionId), {
      deviceId: identity.deviceId,
      deviceName,
      publicKeyPem: identity.publicKeyPem,
      signature: identity.signText(signedText),
      ticket,
    }),
  );

  // Trusted devices are accepted immediately; new ones wait for the desktop user.
  const accepted = await awaitFrameOrError(client, (f) => f.type === "pair.accepted", "pair.accepted", acceptedTimeoutMs);
  const ap = (accepted.payload || {}) as Record<string, unknown>;
  return { deviceToken: typeof ap.deviceToken === "string" ? ap.deviceToken : "" };
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
  const result = await answerChallenge(client, payload.hostId, identity, deviceName, payload.ticket, 5 * 60_000, (s) => onStage?.(s)).catch((e: Error) => fail(e.message));
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
): Promise<PairingResult> {
  return answerChallenge(client, hostId, identity, deviceName, "", 30_000);
}
