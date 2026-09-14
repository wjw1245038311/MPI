/**
 * Mobile E2E crypto — PWA side (docs/MOBILE-DESIGN.md §4.1/§4.2).
 * WebCrypto AES-GCM + noble HKDF; runs on browser and Node ≥24 alike.
 * The host implements the same scheme in src/main/remote/e2e-crypto.ts —
 * scripts/test-e2e-crypto.mjs pins both to identical fixed-input outputs.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
// v1.9.x: X25519 ships inside the ed25519 module (no standalone subpath export).
import { x25519 } from "@noble/curves/ed25519";
import { fromBase64Url, toBase64Url } from "./device-identity";

export const E2E_FRAME_VERSION = 1 as const;

/** info string per §4.2 — must match the host byte-for-byte. */
export function e2eInfoString(hostId: string, deviceId: string): string {
  return `mpi-mobile-v1|${hostId}|${deviceId}`;
}

/** HKDF-SHA256 → 32B AES-256-GCM key (empty salt per §4.2). */
export function deriveAesKeyRaw(sharedSecret: Uint8Array, hostId: string, deviceId: string): Uint8Array {
  return hkdf(sha256, sharedSecret, new Uint8Array(0), e2eInfoString(hostId, deviceId), 32);
}

/** X25519 ECDH (RFC 7748) from raw base64url keys — must match the host's node:crypto result. */
export function x25519SharedSecretRaw(privB64u: string, theirPubB64u: string): Uint8Array {
  return x25519.getSharedSecret(fromBase64Url(privB64u), fromBase64Url(theirPubB64u));
}

/** Copy into a fresh ArrayBuffer — WebCrypto wants BufferSource (not SAB-backed views). */
function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asBuffer(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface E2EFrame {
  e: typeof E2E_FRAME_VERSION;
  /** 12-byte GCM nonce, base64url. */
  n: string;
  /** ciphertext || 16-byte auth tag, base64url (WebCrypto output layout). */
  c: string;
}

export async function encryptFrame(key: CryptoKey, plaintextJson: string): Promise<E2EFrame> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ctTag = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: asBuffer(nonce) }, key, new TextEncoder().encode(plaintextJson)));
  return { e: E2E_FRAME_VERSION, n: toBase64Url(nonce), c: toBase64Url(ctTag) };
}

/** Rejects (throws) on tampered ciphertext/tag/nonce. */
export async function decryptFrame(key: CryptoKey, frame: Pick<E2EFrame, "n" | "c">): Promise<string> {
  const nonce = fromBase64Url(frame.n);
  if (nonce.length !== 12) throw new Error("invalid E2E nonce length");
  const data = fromBase64Url(frame.c);
  if (data.length < 17) throw new Error("E2E frame too short");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: asBuffer(nonce) }, key, asBuffer(data));
  return new TextDecoder().decode(plain);
}
