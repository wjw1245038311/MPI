/**
 * S7 WebPush (VAPID) sender — zero-dependency implementation on node:crypto.
 *
 * Spec: RFC 8291 (Web Push message encryption, aes128gcm) + RFC 8188 (content
 * encoding) + RFC 8292 (VAPID). The relay holds the VAPID private key; the PWA
 * subscribes with browser-generated P-256 keys and receives pushes at
 * subscription.endpoint. Pinned against the RFC 8291 §5 test vector in
 * scripts/test-webpush.mjs.
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

/** HKDF-SHA256 extract step (RFC 5869). */
function hkdfExtract(salt, ikm) {
  return crypto.createHmac("sha256", salt).update(ikm).digest();
}

/** HKDF-SHA256 expand step (RFC 5869). */
function hkdfExpand(prk, info, len) {
  const chunks = [];
  let t = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(chunks).length < len; i++) {
    t = crypto.createHmac("sha256", prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    chunks.push(t);
  }
  return Buffer.concat(chunks).subarray(0, len);
}

/** Record size advertised in the aes128gcm header (RFC 8188 §2). */
const RS = 4096;

/**
 * RFC 8291 §4 aes128gcm content encryption + RFC 8188 §2 body framing.
 *
 * Two HKDF stages: the subscription's auth secret is the stage-1 salt and both
 * public keys are bound into the `WebPush: info` context; the per-message salt
 * then derives the content key and nonce. The pre-RFC draft scheme (single
 * HKDF with salt="" and a transmitted nonce) is deliberately gone — it is not
 * interoperable with browsers.
 *
 * Body: salt(16) || rs(4, BE) || idlen(1) || keyid(sender pub, 65) || ct || tag(16)
 * Record plaintext: payload || 0x02 (padding delimiter at the END of the data).
 *
 * @param plaintext Buffer — the push payload (JSON).
 * @param sub {{ p256dh: string, auth: string }} base64url subscription keys.
 * @param opts {{ ephPrivB64u?: string, saltB64u?: string }} fixed values for tests.
 * @returns {{ body: Buffer, senderPubB64u: string, saltB64u: string }}
 */
export function encryptWebPushPayload(plaintext, sub, opts = {}) {
  const clientPub = Buffer.from(sub.p256dh, "base64url");
  if (clientPub.length !== 65 || clientPub[0] !== 0x04) throw new Error("invalid p256dh key");
  const authSecret = Buffer.from(sub.auth, "base64url");
  if (authSecret.length !== 16) throw new Error("invalid auth secret");

  // Sender key: ephemeral ECDH. createECDH takes the raw scalar directly and
  // getPublicKey() returns the uncompressed point needed for the keyid field.
  const ecdh = crypto.createECDH("prime256v1");
  if (opts.ephPrivB64u) {
    const raw = Buffer.from(opts.ephPrivB64u, "base64url");
    if (raw.length !== 32) throw new Error("invalid ephemeral private key");
    ecdh.setPrivateKey(raw);
  } else {
    ecdh.generateKeys();
  }
  const senderPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(clientPub);
  const salt = opts.saltB64u ? Buffer.from(opts.saltB64u, "base64url") : crypto.randomBytes(16);
  if (salt.length !== 16) throw new Error("invalid salt");

  const prkCombine = hkdfExtract(authSecret, shared);
  const ikm = hkdfExpand(
    prkCombine,
    Buffer.concat([Buffer.from("WebPush: info", "ascii"), Buffer.from([0]), clientPub, senderPub]),
    32,
  );
  const prk = hkdfExtract(salt, ikm);
  // RFC 8188 info strings carry a trailing NUL octet — omitting it silently
  // produces a valid-looking but undecryptable body.
  const contentKey = hkdfExpand(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm", "ascii"), Buffer.from([0])]), 16);
  const nonce = hkdfExpand(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce", "ascii"), Buffer.from([0])]), 12);

  const cipher = crypto.createCipheriv("aes-128-gcm", contentKey, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])), cipher.final()]);
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(RS, 0);
  const body = Buffer.concat([salt, rsBuf, Buffer.from([senderPub.length]), senderPub, ct, cipher.getAuthTag()]);
  return { body, senderPubB64u: b64url(senderPub), saltB64u: b64url(salt) };
}

/**
 * VAPID-authenticated POST headers (RFC 8292 §3 shape + the Crypto-Key
 * `p256ecdsa` form FCM demands).
 */
export function webPushHeaders({ jwt, vapidPubB64u, ttlSec = 30 }) {
  return {
    authorization: `vapid t=${jwt}, k=${vapidPubB64u}`,
    "crypto-key": `p256ecdsa=${vapidPubB64u}`,
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(ttlSec),
    urgency: "high",
  };
}


