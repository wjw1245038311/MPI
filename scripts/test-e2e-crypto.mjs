/**
 * E2E crypto equivalence test (S3.2, docs/MOBILE-DESIGN.md §4.1/§4.2).
 *
 * Pins the host implementation (src/main/remote/e2e-crypto.ts + identity.ts X25519)
 * and the PWA implementation (mobile/pwa/src/lib/e2e-crypto.ts + device-identity.ts)
 * to identical fixed-input outputs, then cross-checks encrypt/decrypt both ways.
 * Any drift in HKDF info string / key layout / frame format fails here.
 */
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { x25519KeyPair, x25519SharedSecret } = await import("../src/main/remote/identity.ts");
// sanity: generated keys are 32 raw bytes each (format check; e2e pairing proves agreement)
{ const kp = x25519KeyPair(); assert.equal(Buffer.from(kp.pubB64u, "base64url").length, 32); assert.equal(Buffer.from(kp.privB64u, "base64url").length, 32); }
const hostCrypto = await import("../src/main/remote/e2e-crypto.ts");
const pwaCrypto = await import("../mobile/pwa/src/lib/e2e-crypto.ts");

// ---- fixed inputs (deterministic across runs) ---------------------------------
const HOST_ID = "host-test-vector";
const DEVICE_ID = "device-test-vector";
const PLAINTEXT = JSON.stringify({ v: 1, type: "projects.list", reqId: "req-v1", sessionId: "sess-v1" });

// Fixed raw X25519 private keys (base64url of repeated bytes — not low-order points).
const privA = Buffer.alloc(32, 0x77).toString("base64url");
const privB = Buffer.alloc(32, 0x42).toString("base64url");

// Public keys via node only: X25519 pub = scalar mult by the base point (9 || 31×0).
const BASEPOINT_B64U = Buffer.concat([Buffer.from([9]), Buffer.alloc(31)]).toString("base64url");
const pubA = x25519SharedSecret(privA, BASEPOINT_B64U).toString("base64url");
const pubB = x25519SharedSecret(privB, BASEPOINT_B64U).toString("base64url");

// ---- 1. X25519 shared secret: node vs noble (PWA), both directions -------------------
const sharedNodeAB = x25519SharedSecret(privA, pubB);
const sharedNobleAB = pwaCrypto.x25519SharedSecretRaw(privA, pubB);
assert.ok(Buffer.compare(sharedNodeAB, Buffer.from(sharedNobleAB)) === 0, "X25519 A→B: node vs noble mismatch");

const sharedNodeBA = x25519SharedSecret(privB, pubA);
assert.ok(Buffer.compare(sharedNodeBA, sharedNodeAB) === 0, "X25519 is commutative (node side)");

// ---- 2. HKDF key derivation: node vs noble -------------------------------------
const hostKey = hostCrypto.deriveAesKey(sharedNodeAB, HOST_ID, DEVICE_ID);
const pwaKeyRaw = pwaCrypto.deriveAesKeyRaw(new Uint8Array(sharedNobleAB), HOST_ID, DEVICE_ID);
assert.ok(Buffer.compare(hostKey, Buffer.from(pwaKeyRaw)) === 0, "HKDF-derived AES key: host vs PWA mismatch");

// ---- 3. pinned fixed vectors (regression — recompute with PIN_VECTORS=1) --------
const PINNED_SHARED = "af724d91134324137a0b11d6404bd33509b5019bc7b4437c2e82e4347006456c";
const PINNED_AES_KEY = "42ba6d7d8249b9482c7987b7b12b7a283c1ef4ab9c9983ca0c8934bc1ee62b0e";
if (process.env.PIN_VECTORS) {
  console.log("PIN shared:", sharedNodeAB.toString("hex"));
  console.log("PIN aesKey:", hostKey.toString("hex"));
} else {
  assert.equal(sharedNodeAB.toString("hex"), PINNED_SHARED, "pinned X25519 shared secret changed");
  assert.equal(hostKey.toString("hex"), PINNED_AES_KEY, "pinned HKDF AES key changed");
}

// ---- 4. cross-implementation AES-GCM round trips --------------------------------
const pwaKey = await pwaCrypto.importAesKey(new Uint8Array(pwaKeyRaw));

const encByPwa = await pwaCrypto.encryptFrame(pwaKey, PLAINTEXT);
assert.equal(encByPwa.e, 1);
assert.ok(hostCrypto.decryptFrame(hostKey, encByPwa) === PLAINTEXT, "host must decrypt PWA frame");

const encByHost = hostCrypto.encryptFrame(hostKey, PLAINTEXT);
assert.ok((await pwaCrypto.decryptFrame(pwaKey, encByHost)) === PLAINTEXT, "PWA must decrypt host frame");

// ---- 5. tamper detection (both directions) --------------------------------------
async function expectReject(fn, label) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  assert.ok(threw, `${label} should reject`);
}
{
  const badC = { ...encByPwa };
  const cBytes = Buffer.from(badC.c, "base64url");
  cBytes[0] ^= 0x01; // flip a ciphertext bit
  badC.c = cBytes.toString("base64url");
  await expectReject(() => Promise.resolve(hostCrypto.decryptFrame(hostKey, badC)), "host tamper(c)");
}
{
  const badN = { ...encByHost };
  const nBytes = Buffer.from(badN.n, "base64url");
  nBytes[3] ^= 0x80; // wrong nonce
  badN.n = nBytes.toString("base64url");
  await expectReject(() => pwaCrypto.decryptFrame(pwaKey, badN), "PWA tamper(n)");
}

// ---- 6. single-seed device: X25519 derivation is deterministic -------------------
const { createDeviceIdentity } = await import("../mobile/pwa/src/lib/device-identity.ts");
const seed = Buffer.alloc(32, 0x5a).toString("base64url");
assert.equal(createDeviceIdentity(seed).x25519PubB64u, createDeviceIdentity(seed).x25519PubB64u, "X25519 pub must be stable per seed");

// ---- 7. identity schema v2: old files upgrade without losing Ed25519 -------------
const { loadOrCreateIdentity, saveIdentity } = await import("../src/main/remote/identity.ts");
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-e2e-identity-"));
  try {
    // A pre-v2 identity file (no x25519 fields; plaintext secrets — safeStorage stub is off).
    const fresh = loadOrCreateIdentity(dir);
    writeFileSync(
      join(dir, "remote-identity.json"),
      JSON.stringify({ hostId: fresh.hostId, publicKeyPem: fresh.publicKeyPem, privateKeyPem: fresh.privateKeyPem, hmacSecret: fresh.hmacSecret, trustedDevices: [] }, null, 2),
      "utf8",
    );
    const upgraded = loadOrCreateIdentity(dir);
    assert.equal(upgraded.hostId, fresh.hostId, "upgrade keeps hostId");
    assert.equal(upgraded.publicKeyPem, fresh.publicKeyPem, "upgrade keeps Ed25519 public key");
    assert.equal(Buffer.from(upgraded.x25519PubB64u, "base64url").length, 32, "upgrade adds X25519 pub");
    // Round trip: the upgraded file reloads with identical keys.
    saveIdentity(dir, upgraded);
    const reloaded = loadOrCreateIdentity(dir);
    assert.equal(reloaded.x25519PubB64u, upgraded.x25519PubB64u, "X25519 pub stable across save/load");
    assert.equal(reloaded.x25519PrivB64u, upgraded.x25519PrivB64u, "X25519 priv stable across save/load (protected at rest)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("e2e-crypto tests passed");
