/**
 * S7 WebPush (VAPID) sender — zero-dependency implementation on node:crypto.
 *
 * Spec: RFC 8291 (Web Push protocol, aes128gcm content encryption) + the VAPID
 * authorization scheme (ES256 JWT). The relay holds the VAPID private key; the
 * PWA subscribes with its browser-generated P-256 keys and receives pushes at
 * subscription.endpoint. Cross-checked against the `web-push` package in
 * scripts/test-webpush.mjs (devDependency only — not a runtime dep, keeping the
 * relay's "仅 ws" constraint).
 */
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Uncompressed P-256 point (0x04||X||Y, 65 bytes) as base64url. */
function pubPointB64u(publicKeyObj) {
  const jwk = publicKeyObj.export({ format: "jwk" });
  return b64url(Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]));
}

/** Load (or generate + persist) the relay's VAPID ECDSA P-256 keypair. */
export function loadOrCreateVapidKey(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw?.privPem === "string" && typeof raw?.pubB64u === "string") return raw;
  } catch { /* generate below */ }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const out = {
    privPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pubB64u: pubPointB64u(publicKey),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  return out;
}

/**
 * ECDSA DER signature → raw r||s (64 bytes). Node ≥24 dropped the
 * dsaEncoding:"ieee_p1363" option, but the Web Push spec requires raw r||s.
 */
export function derToRawSig(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("bad DER signature");
  i++; // total length — P-256 signatures are always <128 bytes (short form)
  const readInt = () => {
    if (der[i++] !== 0x02) throw new Error("bad DER INTEGER");
    const len = der[i++];
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > 1 && v[0] === 0x00) v = v.subarray(1); // strip leading-zero pad
    return v;
  };
  const r = readInt();
  const s = readInt();
  if (r.length > 32 || s.length > 32) throw new Error("bad DER INTEGER length");
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length); // right-align into each half
  s.copy(out, 64 - s.length);
  return out;
}

/** VAPID JWT (ES256) with the raw r||s signature the Web Push spec requires. */
export function vapidJwt({ privPem, aud, sub, ttlSec = 180 }) {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud, exp: Math.floor(Date.now() / 1000) + ttlSec, sub };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(claims)))}`;
  const signer = crypto.createSign("sha256");
  signer.update(signingInput);
  const sig = derToRawSig(signer.sign(crypto.createPrivateKey(privPem)));
  return `${signingInput}.${b64url(sig)}`;
}

/**
 * RFC 8291 §4.2 key schedule: HKDF-SHA256(ikm=ECDH shared secret, salt="",
 * info="WebPush") → 32 bytes = [16B AES-128-GCM content key][16B auth key].
 * Exported so tests can pin the constants with a fixed vector.
 */
export function deriveKeyMaterial(sharedSecret) {
  const hkdfRaw = crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), Buffer.from("WebPush", "ascii"), 32);
  // Node ≥24 returns an ArrayBuffer from hkdfSync — normalize.
  const out = Buffer.isBuffer(hkdfRaw) ? hkdfRaw : Buffer.from(hkdfRaw);
  return { contentKey: out.subarray(0, 16), authKey: out.subarray(16, 32) };
}

/**
 * RFC 8291 aes128gcm content encryption.
 * @param plaintext Buffer — the push payload (JSON).
 * @param p256dhB64u base64url uncompressed P-256 point from the subscription.
 * @param ephPrivB64u optional fixed ephemeral private key (raw 32B b64url) for
 *   deterministic tests; a random one is generated when omitted.
 * @returns { body: Buffer, cryptoKey: string, authKey: Buffer }
 *   body = 0x02 || nonce(12) || ciphertext||tag; cryptoKey for the Crypto-Key
 *   header (ephemeral server key); authKey for the Authorization `t` tag.
 */
export function encryptWebPushPayload(plaintext, p256dhB64u, ephPrivB64u) {
  const clientPub = Buffer.from(p256dhB64u, "base64url");
  if (clientPub.length !== 65 || clientPub[0] !== 0x04) throw new Error("invalid p256dh key");
  // ECDH class: setPrivateKey accepts the raw scalar directly — no KeyObject /
  // PKCS8 wrapping needed. getPublicKey() returns the uncompressed point
  // (0x04||X||Y) for the Crypto-Key header; computeSecret gives the shared x.
  const ecdh = crypto.createECDH("prime256v1");
  if (ephPrivB64u) {
    const raw = Buffer.from(ephPrivB64u, "base64url");
    if (raw.length !== 32) throw new Error("invalid ephemeral private key");
    ecdh.setPrivateKey(raw);
  } else {
    ecdh.generateKeys();
  }
  const shared = ecdh.computeSecret(clientPub);
  const { contentKey, authKey } = deriveKeyMaterial(shared);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-128-gcm", contentKey, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const body = Buffer.concat([Buffer.from([0x02]), nonce, ct, cipher.getAuthTag()]);
  return { body, cryptoKey: b64url(ecdh.getPublicKey()), authKey };
}

/** Authorization `t` parameter: base64(HMAC-SHA256(authKey, JWT)) truncated to 16 bytes. */
export function vapidAuthTag(jwtString, authKey) {
  return crypto.createHmac("sha256", authKey).update(Buffer.from(jwtString)).digest().subarray(0, 16).toString("base64");
}
