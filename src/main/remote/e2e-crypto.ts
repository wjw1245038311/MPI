/**
 * Mobile E2E crypto — host side (docs/MOBILE-DESIGN.md §4.1/§4.2).
 *
 * Session key: HKDF-SHA256(ikm=X25519 shared secret, salt="", info="mpi-mobile-v1|<hostId>|<deviceId>")
 * → 32-byte AES-256-GCM key. Data frames travel as {"e":1,"n":"<nonce b64url>","c":"<ct||tag b64url>"};
 * the relay forwards them opaquely (plus routing tags). The PWA implements the same
 * scheme with WebCrypto + noble HKDF — scripts/test-e2e-crypto.mjs pins both sides to
 * identical fixed-input outputs and cross-checks encrypt/decrypt.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const E2E_FRAME_VERSION = 1 as const;

/** info string per §4.2 — must match the PWA byte-for-byte. */
export function e2eInfoString(hostId: string, deviceId: string): string {
  return `mpi-mobile-v1|${hostId}|${deviceId}`;
}

/** HKDF-SHA256 → 32B AES-256-GCM key (empty salt per §4.2). */
export function deriveAesKey(sharedSecret: Buffer, hostId: string, deviceId: string): Buffer {
  // Node ≥24 hkdfSync returns an ArrayBuffer — normalize to Buffer.
  const key = hkdfSync("sha256", sharedSecret, Buffer.alloc(0), e2eInfoString(hostId, deviceId), 32);
  return Buffer.isBuffer(key) ? key : Buffer.from(key as unknown as ArrayBuffer);
}

export interface E2EFrame {
  e: typeof E2E_FRAME_VERSION;
  /** 12-byte GCM nonce, base64url. */
  n: string;
  /** ciphertext || 16-byte auth tag, base64url. */
  c: string;
}

export function encryptFrame(key: Buffer, plaintextJson: string): E2EFrame {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintextJson, "utf8"), cipher.final()]);
  return { e: E2E_FRAME_VERSION, n: nonce.toString("base64url"), c: Buffer.concat([ct, cipher.getAuthTag()]).toString("base64url") };
}

/** Throws on tampered ciphertext/tag/nonce. */
export function decryptFrame(key: Buffer, frame: Pick<E2EFrame, "n" | "c">): string {
  const nonce = Buffer.from(frame.n, "base64url");
  if (nonce.length !== 12) throw new Error("invalid E2E nonce length");
  const data = Buffer.from(frame.c, "base64url");
  if (data.length < 17) throw new Error("E2E frame too short");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString("utf8");
}
