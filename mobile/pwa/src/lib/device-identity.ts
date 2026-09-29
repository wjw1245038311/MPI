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

/**
 * 配对证明 v2（见 docs/RELAY-SHARING.md §9）：把 E2E 公钥绑进签名。
 *
 * v1 的签名文本不含 X25519 公钥，而两端的公钥都走**明文**中继帧 → 一个不可信的中继可以把
 * 自己的公钥分别塞给两端，各自与中继派生会话密钥，从而解开全部「加密」流量。
 * v2 把各自的公钥写进被签名的文本，换公钥就必须伪造签名（中继没有私钥）。
 */
export function hostProofText(hostId: string, connectionId: string, challenge: string, hostX25519Pub: string): string {
  return `mpi-remote-v2-host|${hostId}|${connectionId}|${challenge}|${hostX25519Pub}`;
}

export function deviceProofText(
  hostId: string,
  connectionId: string,
  challenge: string,
  deviceId: string,
  deviceX25519Pub: string,
): string {
  return `mpi-remote-v2-device|${hostId}|${connectionId}|${challenge}|${deviceId}|${deviceX25519Pub}`;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** SPKI PEM → raw 32B 公钥（验签用）。 */
export function ed25519RawFromPem(pem: string): Uint8Array | null {
  try {
    const b64 = pem
      .replace("-----BEGIN PUBLIC KEY-----", "")
      .replace("-----END PUBLIC KEY-----", "")
      .replace(/\s+/g, "");
    const der = base64UrlToBytes(b64.replace(/\+/g, "-").replace(/\//g, "_"));
    if (der.length !== ED25519_SPKI_PREFIX.length + 32) return null;
    return der.slice(ED25519_SPKI_PREFIX.length);
  } catch {
    return null;
  }
}

/** 用主机身份公钥验签（配对时验主机身份与它的 E2E 公钥）。失败一律 false。 */
export function verifyHostSignature(publicKeyPem: string, text: string, signatureB64u: string): boolean {
  try {
    const raw = ed25519RawFromPem(publicKeyPem);
    if (!raw) return false;
    return ed25519.verify(base64UrlToBytes(signatureB64u), new TextEncoder().encode(text), raw);
  } catch {
    return false;
  }
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
