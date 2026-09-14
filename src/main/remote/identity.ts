import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";

export interface TrustedRemoteDevice {
  deviceId: string;
  name: string;
  publicKeyPem: string;
  addedAt: number;
  lastSeenAt?: number;
}
export interface HostIdentity {
  hostId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  hmacSecret: string;
  trustedDevices: TrustedRemoteDevice[];
  /** X25519 key pair for mobile E2E (schema v2, docs/MOBILE-DESIGN.md §4.2).
   * Raw 32-byte keys as base64url; the private one is protected at rest. */
  x25519PubB64u: string;
  x25519PrivB64u: string;
}

// X25519 DER wrappers (RFC 8410) — fixed prefixes around the raw 32-byte key.
const X25519_SPKI_PREFIX = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);
const X25519_PKCS8_PREFIX = Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

export function x25519KeyPair(): { pubB64u: string; privB64u: string } {
  const pair = generateKeyPairSync("x25519");
  const pubDer = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privDer = pair.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  return { pubB64u: pubDer.subarray(-32).toString("base64url"), privB64u: privDer.subarray(-32).toString("base64url") };
}

/** X25519 ECDH shared secret (RFC 7748) from raw base64url keys. */
export function x25519SharedSecret(privB64u: string, theirPubB64u: string): Buffer {
  const privateKey = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(privB64u, "base64url")]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(theirPubB64u, "base64url")]), format: "der", type: "spki" });
  return diffieHellman({ privateKey, publicKey });
}

function hostIdFor(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 24);
}

export function fingerprintFor(publicKeyPem: string): string {
  return `sha256-${createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 32)}`;
}

function createIdentity(): HostIdentity {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const xKeys = x25519KeyPair();
  return {
    hostId: hostIdFor(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    hmacSecret: randomBytes(32).toString("base64url"),
    trustedDevices: [],
    x25519PubB64u: xKeys.pubB64u,
    x25519PrivB64u: xKeys.privB64u,
  };
}

function protect(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(value).toString("base64")}`;
  } catch {
    /* Electron safeStorage may not be ready in a test shell; use the fallback. */
  }
  return value;
}

function unprotect(value: string): string {
  if (!value.startsWith("enc:")) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
  } catch {
    return "";
  }
}

function persistedIdentity(identity: HostIdentity): Record<string, unknown> {
  return {
    ...identity,
    privateKeyPem: protect(identity.privateKeyPem),
    hmacSecret: protect(identity.hmacSecret),
    x25519PrivB64u: protect(identity.x25519PrivB64u),
  };
}

export function loadOrCreateIdentity(dir: string): HostIdentity {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "remote-identity.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as HostIdentity;
      const privateKeyPem = typeof parsed.privateKeyPem === "string" ? unprotect(parsed.privateKeyPem) : "";
      const hmacSecret = typeof parsed.hmacSecret === "string" ? unprotect(parsed.hmacSecret) : "";
      if (parsed.hostId && parsed.publicKeyPem && privateKeyPem && hmacSecret) {
        const base = { ...parsed, privateKeyPem, hmacSecret, trustedDevices: Array.isArray(parsed.trustedDevices) ? parsed.trustedDevices : [] };
        // Schema v2 upgrade path for pre-X25519 files.
        if (typeof base.x25519PubB64u === "string" && typeof base.x25519PrivB64u === "string") {
          const xPriv = unprotect(base.x25519PrivB64u);
          if (xPriv) return { ...base, x25519PubB64u: base.x25519PubB64u, x25519PrivB64u: xPriv };
        }
        const xKeys = x25519KeyPair();
        const identity = { ...base, x25519PubB64u: xKeys.pubB64u, x25519PrivB64u: xKeys.privB64u };
        saveIdentity(dir, identity); // persist the upgrade immediately
        return identity;
      }
    } catch {
      /* recreate a corrupt identity */
    }
  }
  const identity = createIdentity();
  writeFileSync(file, JSON.stringify(persistedIdentity(identity), null, 2), "utf8");
  return identity;
}

export function saveIdentity(dir: string, identity: HostIdentity): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "remote-identity.json"), JSON.stringify(persistedIdentity(identity), null, 2), "utf8");
}

export function opaqueId(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url").slice(0, 24);
}

export function signText(privateKeyPem: string, text: string): string {
  return sign(null, Buffer.from(text, "utf8"), createPrivateKey(privateKeyPem)).toString("base64url");
}

export function verifyText(publicKeyPem: string, text: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(text, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function deviceIdFor(publicKeyPem: string): string {
  return `device-${createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 24)}`;
}
