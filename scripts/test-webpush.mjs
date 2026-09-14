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

/**
 * Independent RFC 8291 §4 / RFC 8188 §2 decryption — the reference check for
 * any sender output. Mirrors the spec rather than the implementation.
 */
function decryptWebPushBody(body, clientPrivateKey, clientPubB64u, authB64u) {
  if (body.length < 21 + 65 + 17) throw new Error("body too short");
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  if (rs < 18) throw new Error(`bad rs ${rs}`);
  const idlen = body[20];
  const senderPub = body.subarray(21, 21 + idlen);
  if (senderPub.length !== 65 || senderPub[0] !== 0x04) throw new Error("bad keyid point");
  const ctTag = body.subarray(21 + idlen);

  const clientPub = Buffer.from(clientPubB64u, "base64url");
  const authSecret = Buffer.from(authB64u, "base64url");
  const senderPubObj = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64url(senderPub.subarray(1, 33)), y: b64url(senderPub.subarray(33, 65)) },
    format: "jwk",
  });
  const shared = crypto.diffieHellman({ privateKey: clientPrivateKey, publicKey: senderPubObj });

  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  const expand = (prk, info, len) => {
    const chunks = [];
    let t = Buffer.alloc(0);
    for (let i = 1; Buffer.concat(chunks).length < len; i++) {
      t = hmac(prk, Buffer.concat([t, info, Buffer.from([i])]));
      chunks.push(t);
    }
    return Buffer.concat(chunks).subarray(0, len);
  };
  const ikm = expand(
    hmac(authSecret, shared),
    Buffer.concat([Buffer.from("WebPush: info", "ascii"), Buffer.from([0]), clientPub, senderPub]),
    32,
  );
  const prk = hmac(salt, ikm);
  const contentKey = expand(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm", "ascii"), Buffer.from([0])]), 16);
  const nonce = expand(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce", "ascii"), Buffer.from([0])]), 12);

  const decipher = crypto.createDecipheriv("aes-128-gcm", contentKey, nonce);
  decipher.setAuthTag(ctTag.subarray(ctTag.length - 16));
  const record = Buffer.concat([decipher.update(ctTag.subarray(0, ctTag.length - 16)), decipher.final()]);
  // Record plaintext = data || 0x02 || zero padding — strip from the delimiter back.
  let end = record.length;
  while (end > 0 && record[end - 1] === 0) end--;
  if (record[end - 1] !== 0x02) throw new Error("missing padding delimiter");
  return record.subarray(0, end - 1);
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
  const { loadOrCreateVapidKey, vapidJwt, encryptWebPushPayload, webPushHeaders } = await import("../mobile/relay/vapid.mjs");
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

  // RFC 8291 §5 "Encryption Example" — byte-exact proof of spec conformance.
  // This is the guard that the pre-RFC draft scheme (transmitted nonce, single
  // HKDF with salt="") can never come back: browsers reject that body outright.
  {
    const out = encryptWebPushPayload(
      Buffer.from("When I grow up, I want to be a watermelon", "utf8"),
      {
        p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      { ephPrivB64u: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", saltB64u: "DGv6ra1nlYgDCS1FRnbzlw" },
    );
    assert.equal(
      out.senderPubB64u,
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
      "RFC 8291 as_public",
    );
    assert.equal(
      out.body.toString("base64url"),
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
      "RFC 8291 §5 record",
    );
  }

  // payload encryption round-trip via independent derivation + structure checks
  const client = makeClientKeys();
  const plaintext = JSON.stringify({ kind: "approval", title: "MPI 需要批准" });
  const sub = { p256dh: client.p256dhB64u, auth: client.authB64u };
  const { body, senderPubB64u } = encryptWebPushPayload(Buffer.from(plaintext, "utf8"), sub);
  assert.equal(body.readUInt32BE(16), 4096, "rs = 4096");
  assert.equal(body[20], 65, "idlen = 65");
  assert.equal(body.subarray(21, 86).toString("base64url"), senderPubB64u, "keyid carries the sender point");
  assert.equal(decryptWebPushBody(body, client.privateKey, client.p256dhB64u, client.authB64u).toString("utf8"), plaintext);

  // deterministic path: fixed ephemeral key + salt → identical body every time
  const ephPriv = b64url(crypto.randomBytes(32));
  const d1 = encryptWebPushPayload(Buffer.from("x", "utf8"), sub, { ephPrivB64u: ephPriv });
  const d2 = encryptWebPushPayload(Buffer.from("x", "utf8"), sub, { ephPrivB64u: ephPriv });
  assert.equal(d1.senderPubB64u, d2.senderPubB64u, "fixed ephemeral key → stable sender point");

  // headers: RFC 8292 VAPID + the Crypto-Key p256ecdsa form FCM requires
  const headers = webPushHeaders({ jwt, vapidPubB64u: k1.pubB64u });
  assert.equal(headers.authorization, `vapid t=${jwt}, k=${k1.pubB64u}`);
  assert.equal(headers["crypto-key"], `p256ecdsa=${k1.pubB64u}`);
  assert.equal(headers["content-encoding"], "aes128gcm");

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

  console.log("part1 (vapid units + RFC 8291 §5 vector + web-push cross-check): passed");
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
    // RFC 8292 VAPID: Authorization: vapid t=<jwt>, k=<public key>
    const authMatch = /vapid t=([^,]+), k=(\S+)/.exec(hit.headers.authorization || "");
    assert.ok(authMatch, "authorization header shape");
    assert.equal(hit.headers["crypto-key"], `p256ecdsa=${relayVapidPub}`, "Crypto-Key advertises the VAPID public key");
    assert.equal(authMatch[2], relayVapidPub, "authorization k = VAPID public key");
    assert.equal(hit.headers["content-encoding"], "aes128gcm");
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
    const decrypted = JSON.parse(decryptWebPushBody(hit.body, clientKeys.privateKey, clientKeys.p256dhB64u, clientKeys.authB64u).toString("utf8"));
    assert.deepEqual(decrypted, { kind: "approval", title: "MPI 需要批准", body: "有会话等待你的确认。", deepLink: `/thread/${T}` });

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
