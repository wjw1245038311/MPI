/**
 * S7 end-to-end: WebPush (VAPID) approval notifications.
 *
 * Part 1 (units, relay vapid.mjs):
 *   - VAPID key generate/persist/load; JWT structure + ES256 signature verify
 *   - RFC 8291 aes128gcm payload: independent-derivation decryption round-trip
 *   - cross-check against the `web-push` package (devDependency only): its
 *     encrypt output decrypts with our derivation, its VAPID JWT verifies —
 *     both implementations are spec-conformant and interchangeable
 * Part 2 (full stack over relay + E2E):
 *   - PWA reports a PushSubscription via the encrypted push.subscribe frame →
 *     real RemoteService dispatch → backend persists → uplink syncs to relay
 *   - uplink.sendPush → relay signs/encrypts/POSTs to the fake endpoint:
 *     Authorization JWT (aud/exp/sub + signature), t tag, Crypto-Key header and
 *     body all verify against the VAPID public key from /vapid-public-key
 *   - 410 Gone → subscription removed; later pushes are no-ops (delivered:false)
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register(new URL("./electron-stub-loader.mjs", import.meta.url));

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** raw r||s (64B) → DER, so the default crypto.verify path can check it. */
function rawToDerSig(raw64) {
  const enc = (v) => {
    let b = Buffer.from(v);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); // high bit → zero pad
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  };
  const r = enc(raw64.subarray(0, 32));
  const s = enc(raw64.subarray(32, 64));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

async function startRelay(extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, "mobile", "relay", "index.mjs")], {
    env: { ...process.env, RELAY_PORT: "0", RELAY_PING_MS: "500", RELAY_DEAD_MS: "1000", ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let buffer = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay did not become ready in 5s")), 5_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const m = buffer.match(/ready ws:\/\/[^:]+:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`relay exited early (code ${code})`)));
  });
  return { child, port };
}

async function waitFor(fn, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Independent RFC 8291 decryption — the reference check for any sender output. */
function decryptWebPushBody(body, cryptoKeyB64u, clientPrivateKey) {
  if (body[0] !== 0x02) throw new Error(`bad version byte ${body[0]}`);
  const nonce = body.subarray(1, 13);
  const ctTag = body.subarray(13);
  const ephRaw = Buffer.from(cryptoKeyB64u, "base64url");
  if (ephRaw.length !== 65 || ephRaw[0] !== 0x04) throw new Error("bad Crypto-Key point");
  const ephPub = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64url(ephRaw.subarray(1, 33)), y: b64url(ephRaw.subarray(33, 65)) },
    format: "jwk",
  });
  const shared = crypto.diffieHellman({ privateKey: clientPrivateKey, publicKey: ephPub });
  const hkdfRaw = crypto.hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("WebPush", "ascii"), 32);
  const hkdfOut = Buffer.isBuffer(hkdfRaw) ? hkdfRaw : Buffer.from(hkdfRaw);
  const decipher = crypto.createDecipheriv("aes-128-gcm", hkdfOut.subarray(0, 16), nonce);
  decipher.setAuthTag(ctTag.subarray(ctTag.length - 16));
  return Buffer.concat([decipher.update(ctTag.subarray(0, ctTag.length - 16)), decipher.final()]);
}

function makeClientKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    p256dhB64u: b64url(Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")])),
    authB64u: b64url(crypto.randomBytes(16)),
  };
}

// ---------------------------------------------------------------------------
// Part 1: relay vapid.mjs units + web-push cross-check.
// ---------------------------------------------------------------------------
async function part1Units() {
  const { loadOrCreateVapidKey, vapidJwt, encryptWebPushPayload, vapidAuthTag, deriveKeyMaterial } = await import("../mobile/relay/vapid.mjs");
  const webpush = (await import("web-push")).default;

  // key generate + persist + reload
  const keyFile = join(mkdtempSync(join(tmpdir(), "mpi-webpush-")), "vapid.json");
  const k1 = loadOrCreateVapidKey(keyFile);
  const k2 = loadOrCreateVapidKey(keyFile);
  assert.equal(k1.pubB64u, k2.pubB64u, "keypair persists across loads");

  // JWT structure + signature
  const jwt = vapidJwt({ privPem: k1.privPem, aud: "http://example.test", sub: "mailto:a@b.c" });
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.equal(claims.aud, "http://example.test");
  assert.equal(claims.sub, "mailto:a@b.c");
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));
  const pubKeyObj = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64url(Buffer.from(k1.pubB64u, "base64url").subarray(1, 33)), y: b64url(Buffer.from(k1.pubB64u, "base64url").subarray(33, 65)) },
    format: "jwk",
  });
  assert.ok(
    crypto.verify("sha256", Buffer.from(`${h}.${c}`), pubKeyObj, rawToDerSig(Buffer.from(s, "base64url"))),
    "VAPID JWT ES256 signature verifies (raw r||s re-wrapped to DER)",
  );

  // pinned key-schedule vector (RFC 8291 §4.2): HKDF-SHA256(ikm=32×0xAB,
  // salt="", info="WebPush") — pins the constants against silent drift.
  {
    const { contentKey, authKey } = deriveKeyMaterial(Buffer.alloc(32, 0xab));
    assert.equal(contentKey.toString("hex"), "524abf5d052237af577d56ffdac0c713", "pinned content key");
    assert.equal(authKey.toString("hex"), "d0ca6b4a6c3748a0fa7a7388af52836d", "pinned auth key");
  }

  // payload encryption round-trip via independent derivation + structure checks
  const client = makeClientKeys();
  const plaintext = JSON.stringify({ kind: "approval", title: "MPI 需要批准" });
  const { body, cryptoKey } = encryptWebPushPayload(Buffer.from(plaintext, "utf8"), client.p256dhB64u);
  assert.equal(body[0], 0x02, "RFC 8291 version byte");
  assert.ok(body.length >= 1 + 12 + 16, "version+nonce+tag minimum length");
  assert.equal(decryptWebPushBody(body, cryptoKey, client.privateKey).toString("utf8"), plaintext);

  // deterministic path: fixed ephemeral key → same Crypto-Key header every time
  const ephPriv = b64url(crypto.randomBytes(32));
  const d1 = encryptWebPushPayload(Buffer.from("x", "utf8"), client.p256dhB64u, ephPriv);
  const d2 = encryptWebPushPayload(Buffer.from("x", "utf8"), client.p256dhB64u, ephPriv);
  assert.equal(d1.cryptoKey, d2.cryptoKey, "fixed ephemeral key → stable Crypto-Key header");

  // and web-push's VAPID JWT must verify the same way ours does (ES256 raw r||s)
  const vapidKeys = webpush.generateVAPIDKeys();
  // getVapidHeaders(audience, subject, publicKeyB64u, privateKeyB64u, contentEncoding)
  const theirHeaders = webpush.getVapidHeaders("https://example.test", "mailto:test@example.com", vapidKeys.publicKey, vapidKeys.privateKey, "aesgcm");
  const m = /^WebPush (\S+)$/.exec(theirHeaders.Authorization);
  assert.ok(m, "web-push authorization header shape: WebPush <jwt>");
  const [th, tc, ts] = m[1].split(".");
  assert.deepEqual(JSON.parse(Buffer.from(th, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  const theirClaims = JSON.parse(Buffer.from(tc, "base64url").toString());
  assert.equal(theirClaims.aud, "https://example.test");
  assert.ok(typeof theirClaims.exp === "number" && typeof theirClaims.sub === "string");
  // web-push returns the public point as a raw b64url string (0x04||X||Y)
  const theirPoint = Buffer.from(vapidKeys.publicKey, "base64url");
  assert.equal(theirPoint.length, 65);
  const theirPub = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64url(theirPoint.subarray(1, 33)), y: b64url(theirPoint.subarray(33, 65)) },
    format: "jwk",
  });
  assert.ok(crypto.verify("sha256", Buffer.from(`${th}.${tc}`), theirPub, rawToDerSig(Buffer.from(ts, "base64url"))), "web-push VAPID JWT verifies (raw r||s)");

  // t tag: base64(HMAC-SHA256(authKey, jwt)) truncated to 16 bytes — recompute for OUR push
  const { authKey } = encryptWebPushPayload(Buffer.from("x", "utf8"), client.p256dhB64u);
  const expectedT = crypto.createHmac("sha256", authKey).update(Buffer.from(jwt)).digest().subarray(0, 16).toString("base64");
  assert.equal(vapidAuthTag(jwt, authKey), expectedT);

  console.log("part1 (vapid units + web-push cross-check): passed");
}

// ---------------------------------------------------------------------------
// Part 2: full stack — relay + uplink + E2E + real RemoteService.
// ---------------------------------------------------------------------------
async function part2FullStack() {
  const userData = mkdtempSync(join(tmpdir(), "mpi-webpush-"));
  let relay = null;
  const clients = [];
  let uplink = null;
  let remoteHost = null;
  let fakePushServer = null;

  // --- fake push endpoint (records deliveries; can go 410) ----------------------
  const hits = [];
  let nextStatus = 201;
  fakePushServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk)); // binary-safe: GCM ciphertext is not text
    req.on("end", () => {
      hits.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(nextStatus, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise((resolve) => fakePushServer.listen(0, "127.0.0.1", resolve));
  const fakePort = fakePushServer.address().port;

  try {
    relay = await startRelay({ RELAY_VAPID_KEY_FILE: join(userData, "vapid.json"), RELAY_ALLOW_INSECURE_PUSH: "1" });
    const url = `ws://127.0.0.1:${relay.port}/ws`;

    // VAPID public key endpoint (what the PWA fetches to subscribe)
    const vapidRes = await fetch(`http://127.0.0.1:${relay.port}/api/v1/remote/web-push/vapid-public-key`);
    assert.equal(vapidRes.status, 200);
    const { publicKey: relayVapidPub } = await vapidRes.json();
    assert.ok(typeof relayVapidPub === "string" && Buffer.from(relayVapidPub, "base64url").length === 65);

    process.env.MPI_TEST_USER_DATA = userData;
    const { RemoteHost } = await import("../src/main/remote/host.ts");
    const { RelayUplink } = await import("../src/main/remote/relay-uplink.ts");
    const { RemoteService } = await import("../src/main/remote/service.ts");
    const { createDeviceIdentity, randomSeedB64url } = await import("../mobile/pwa/src/lib/device-identity.ts");
    const { parsePairingLink, runPairing, attachAutoReauth } = await import("../mobile/pwa/src/lib/pairing.ts");
    const { RelayClient } = await import("../mobile/pwa/src/lib/relay-client.ts");
    const { Requester } = await import("../mobile/pwa/src/lib/requester.ts");

    // --- fake backend behind the REAL RemoteService --------------------------------
    const T = "thread-push";
    const storedSubs = [];
    let uplinkRef = null;
    const makeSnapshot = () => ({
      id: T, projectId: "p1", title: "Push thread", preview: "", updatedAt: Date.now(),
      messageCount: 0, state: "idle", permission: "sandbox",
      cwdName: "demo", model: null, availableModels: [], skills: [], thinkingLevel: "off",
      messages: [], nextSeq: 1,
    });
    const backend = {
      listProjects: async () => [{ id: "p1", name: "Demo", threadCount: 1, updatedAt: Date.now() }],
      listThreads: async () => [makeSnapshot()],
      getThread: async () => makeSnapshot(),
      createThread: async () => makeSnapshot(),
      setPermission: async () => makeSnapshot(),
      setModel: async () => makeSnapshot(),
      prompt: async () => ({}),
      steer: async () => ({}),
      followUp: async () => ({}),
      abort: async () => ({}),
      fileTree: async () => [],
      filePreview: async () => null,
      respondUi: async () => ({}),
      // Mirrors ipc.ts production wiring: persist + sync to the relay via uplink.
      storePushSubscription: async (deviceId, subscription) => {
        storedSubs.push({ deviceId, subscription });
        uplinkRef?.storePushSubscription(deviceId, subscription);
        return { ok: true };
      },
      subscribeThread: () => () => {},
    };

    const rendererEvents = [];
    remoteHost = new RemoteHost({
      userDataDir: userData,
      signalingUrl: "",
      stunUrls: [],
      sendToRenderer: (channel, payload) => rendererEvents.push([channel, payload]),
      service: new RemoteService(backend),
    });
    remoteHost.start();

    const cryptoMaterial = remoteHost.getRelayCryptoMaterial();
    uplink = new RelayUplink({ relayUrl: url, hostId: remoteHost.getStatus().hostId, userDataDir: userData, x25519PrivB64u: cryptoMaterial.x25519PrivB64u, x25519PubB64u: cryptoMaterial.x25519PubB64u, getHost: () => remoteHost });
    uplinkRef = uplink;
    remoteHost.setRelay(uplink);
    uplink.start();
    await waitFor(() => uplink.getStatus().state === "connected", "uplink connected");

    // --- pair -----------------------------------------------------------------------
    const seed = randomSeedB64url();
    const identity = createDeviceIdentity(seed);
    const ticketInfo = remoteHost.createPairingTicket();
    const link = `mpi://pair?payload=${Buffer.from(JSON.stringify({ hostId: ticketInfo.hostId, fingerprint: ticketInfo.fingerprint, hostPublicKeyPem: ticketInfo.hostPublicKeyPem, relayUrl: url, ticket: ticketInfo.ticket, expiresAt: ticketInfo.expiresAt, protocol: 1 })).toString("base64url")}`;
    const payload = parsePairingLink(link);

    const client = new RelayClient({ url });
    clients.push(client);
    const resultPromise = runPairing(client, payload, identity, "test-webpush");
    await waitFor(() => rendererEvents.some(([ch]) => ch === "remote:pairing-request"), "desktop pairing request");
    const pairingRequest = rendererEvents.find(([ch]) => ch === "remote:pairing-request")[1];
    assert.equal(remoteHost.approvePairing(pairingRequest.connectionId), true);
    const pairResult = await resultPromise;
    client.setHelloCreds(identity.deviceId, pairResult.deviceToken);

    // --- report a PushSubscription over the encrypted channel -------------------------
    const clientKeys = makeClientKeys();
    const subscription = {
      endpoint: `http://127.0.0.1:${fakePort}/push`,
      keys: { p256dh: clientKeys.p256dhB64u, auth: clientKeys.authB64u },
    };
    const reporter = new Requester(client);
    await reporter.request("push.subscribe", { subscription }, "push.subscribe");
    reporter.detach();

    assert.equal(storedSubs.length, 1, "host backend persisted the subscription (E2E channel)");
    assert.deepEqual(storedSubs[0].subscription, subscription);
    assert.equal(storedSubs[0].deviceId, identity.deviceId);
    // host → relay sync happened: the relay now holds one push subscription.
    await waitFor(async () => {
      const hz = await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).json();
      return hz.pushSubs === 1;
    }, "relay received the push.subscribe control frame");

    // --- fire a push: relay signs/encrypts/POSTs to the fake endpoint -----------------
    uplink.sendPush(identity.deviceId, { kind: "approval", title: "MPI 需要批准", body: "有会话等待你的确认。", deepLink: `/thread/${T}` });
    await waitFor(() => hits.length === 1, "fake push endpoint received the delivery");

    const hit = hits[0];
    // Authorization: WebPush vapid="<jwt>" t="<tag>"
    const authMatch = /vapid="([^"]+)" t="([^"]+)"/.exec(hit.headers.authorization || "");
    assert.ok(authMatch, "authorization header shape");
    const [jh, jc, js] = authMatch[1].split(".");
    assert.deepEqual(JSON.parse(Buffer.from(jh, "base64url").toString()), { typ: "JWT", alg: "ES256" });
    const jwtClaims = JSON.parse(Buffer.from(jc, "base64url").toString());
    assert.equal(jwtClaims.aud, `http://127.0.0.1:${fakePort}`, "aud = endpoint origin");
    assert.ok(jwtClaims.exp > Math.floor(Date.now() / 1000));
    // signature verifies against the public key served by the relay
    const vapidPubObj = crypto.createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64url(Buffer.from(relayVapidPub, "base64url").subarray(1, 33)), y: b64url(Buffer.from(relayVapidPub, "base64url").subarray(33, 65)) },
      format: "jwk",
    });
    assert.ok(crypto.verify("sha256", Buffer.from(`${jh}.${jc}`), vapidPubObj, rawToDerSig(Buffer.from(js, "base64url"))), "JWT signature verifies against relay VAPID public key");

    // body decrypts with the standard derivation → exact payload
    const decrypted = JSON.parse(decryptWebPushBody(hit.body, hit.headers["crypto-key"], clientKeys.privateKey).toString("utf8"));
    assert.deepEqual(decrypted, { kind: "approval", title: "MPI 需要批准", body: "有会话等待你的确认。", deepLink: `/thread/${T}` });

    // t tag matches HMAC-SHA256(authKey, jwt) truncated to 16 bytes (recompute authKey)
    const ephRaw = Buffer.from(hit.headers["crypto-key"], "base64url");
    const ephPubObj = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(ephRaw.subarray(1, 33)), y: b64url(ephRaw.subarray(33, 65)) }, format: "jwk" });
    const shared = crypto.diffieHellman({ privateKey: clientKeys.privateKey, publicKey: ephPubObj });
    const hkdfRaw = crypto.hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("WebPush", "ascii"), 32);
    const authKey = (Buffer.isBuffer(hkdfRaw) ? hkdfRaw : Buffer.from(hkdfRaw)).subarray(16, 32);
    assert.equal(authMatch[2], crypto.createHmac("sha256", authKey).update(Buffer.from(authMatch[1])).digest().subarray(0, 16).toString("base64"), "t tag is the truncated HMAC of the JWT");

    // --- dead subscription: 410 Gone → relay removes it; later pushes no-op ----------
    nextStatus = 410;
    uplink.sendPush(identity.deviceId, { kind: "approval", title: "x" });
    await waitFor(() => hits.length === 2, "second delivery attempted");
    await waitFor(async () => {
      const hz = await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).json();
      return hz.pushSubs === 0;
    }, "410 removed the subscription from the relay");

    uplink.sendPush(identity.deviceId, { kind: "approval", title: "y" });
    await sleep(300);
    assert.equal(hits.length, 2, "no delivery after the subscription is gone");

    console.log("part2 (full stack over relay + E2E): passed");
  } finally {
    for (const c of clients) c.close();
    uplink?.stop();
    remoteHost?.stop();
    fakePushServer?.close();
    if (relay && !relay.child.killed) relay.child.kill("SIGKILL");
    rmSync(userData, { recursive: true, force: true });
  }
}

await part1Units();
await part2FullStack();
console.log("webpush tests passed");
process.exit(0);
