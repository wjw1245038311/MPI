/**
 * Device identity for the mobile PWA (docs/MOBILE-DESIGN.md §4.2).
 *
 * Ed25519 via @noble/curves (pure TS — avoids the WebCrypto support matrix).
 * The SPKI PEM and deviceId derivation MUST stay byte-compatible with the
 * desktop's src/main/remote/identity.ts (deviceIdFor hashes the PEM string);
 * scripts/test-pwa-pairing.mjs proves it end-to-end against a real host.
 */
import { ed25519 } from "@noble/curves/ed25519";
// v1.9.x: X25519 ships inside the ed25519 module (no standalone subpath export).
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

/** Fixed SPKI DER prefix for Ed25519 (SEQUENCE{SEQUENCE{OID 1.3.101.112}, BITSTRING}). */
const ED25519_SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

export interface DeviceIdentity {
  /** "device-<sha256(SPKI PEM) base64url[:24]>" — matches desktop deviceIdFor(). */
  deviceId: string;
  /** SPKI PEM of the Ed25519 public key (what the host verifies against). */
  publicKeyPem: string;
  /** X25519 public key (raw 32B, base64url) for E2E key agreement. */
  x25519PubB64u: string;
  /** X25519 private key — deterministically derived from the stored Ed25519 seed,
   * so exposing it adds no secret beyond what the keystore already holds. */
  x25519PrivB64u: string;
  /** Sign text → base64url signature (no padding), matching identity.signText. */
  signText(text: string): string;
}

/** Deterministic X25519 private key from the Ed25519 seed (single-seed device). */
export function deriveX25519Priv(ed25519Seed: Uint8Array): Uint8Array {
  return hkdf(sha256, ed25519Seed, new Uint8Array(0), "mpi-device-x25519", 32);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Standard PEM with 64-char base64 lines — byte-identical to Node's spki/pem export. */
export function ed25519SpkiPem(publicKey32: Uint8Array): string {
  const der = new Uint8Array(ED25519_SPKI_PREFIX.length + publicKey32.length);
  der.set(ED25519_SPKI_PREFIX, 0);
  der.set(publicKey32, ED25519_SPKI_PREFIX.length);
  const b64 = bytesToBase64(der).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

function deviceIdFor(publicKeyPem: string): string {
  return `device-${toBase64Url(sha256(utf8Bytes(publicKeyPem))).slice(0, 24)}`;
}

/** Create a fresh identity (or restore from a stored seed). */
export function createDeviceIdentity(seedB64url?: string): DeviceIdentity {
  const priv = seedB64url ? fromBase64Url(seedB64url) : ed25519.utils.randomPrivateKey();
  if (priv.length !== 32) throw new Error("invalid Ed25519 seed length");
  const publicKeyPem = ed25519SpkiPem(ed25519.getPublicKey(priv));
  const xPriv = deriveX25519Priv(priv);
  return {
    deviceId: deviceIdFor(publicKeyPem),
    publicKeyPem,
    x25519PubB64u: toBase64Url(x25519.getPublicKey(xPriv)),
    x25519PrivB64u: toBase64Url(xPriv),
    signText: (text) => toBase64Url(ed25519.sign(utf8Bytes(text), priv)),
  };
}

/** The storable private seed of a freshly generated identity. */
export function randomSeedB64url(): string {
  return toBase64Url(ed25519.utils.randomPrivateKey());
}
