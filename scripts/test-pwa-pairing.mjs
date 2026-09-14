/**
 * S2/S3 end-to-end: the PWA's own library code (RelayClient + device-identity +
 * pairing) pairs with a real RemoteHost+RelayUplink through the real relay.
 *
 * Proves, among other things:
 *  - noble Ed25519 SPKI PEM / deviceId derivation is byte-compatible with the
 *    desktop's identity.ts (the host verifies it);
 *  - S3 E2E: after pair.accepted both directions carry {e,n,c} ciphertext on the
 *    wire (spied via WebSocket.prototype.send for the uplink and RelayClient
 *    onSend for the PWA), while handshake frames stay plaintext; the fake host
 *    service receives decrypted envelopes and its encrypted response is
 *    decrypted by the PWA client; reconnect re-derives the same key locally.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register(new URL("./electron-stub-loader.mjs", import.meta.url));

async function startRelay() {
  const child = spawn(process.execPath, [join(ROOT, "mobile", "relay", "index.mjs")], {
    env: { ...process.env, RELAY_PORT: "0", RELAY_PING_MS: "500", RELAY_DEAD_MS: "1000" },
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

async function main() {
  const userData = mkdtempSync(join(tmpdir(), "mpi-pwa-pairing-"));
  let relay = null;
  const clients = [];
  let uplink = null;
  let remoteHost = null;
  try {
    relay = await startRelay();
    const url = `ws://127.0.0.1:${relay.port}/ws`;

    process.env.MPI_TEST_USER_DATA = userData;
    const { RemoteHost } = await import("../src/main/remote/host.ts");
    const { RelayUplink } = await import("../src/main/remote/relay-uplink.ts");
    // The PWA's own library code under test (node-compatible).
    const { createDeviceIdentity, randomSeedB64url } = await import("../mobile/pwa/src/lib/device-identity.ts");
    const { parsePairingLink, runPairing, reauthenticate } = await import("../mobile/pwa/src/lib/pairing.ts");
    const { RelayClient } = await import("../mobile/pwa/src/lib/relay-client.ts");
    const { makeEnvelope, responseFor } = await import("../mobile/shared/protocol.ts");

    // --- unit: parsePairingLink ------------------------------------------------------
    assert.throws(() => parsePairingLink(""));
    assert.throws(() => parsePairingLink("mpi://pair?payload=!!!not-base64-json"));
    const parsedBare = parsePairingLink(Buffer.from(JSON.stringify({ hostId: "h", ticket: "t" })).toString("base64url"));
    assert.equal(parsedBare.hostId, "h");

    // --- boot host + uplink -----------------------------------------------------------
    const rendererEvents = [];
    const handledEnvelopes = []; // what the (fake) host service receives — must be plaintext
    remoteHost = new RemoteHost({
      userDataDir: userData,
      signalingUrl: "",
      stunUrls: [],
      sendToRenderer: (channel, payload) => rendererEvents.push([channel, payload]),
      service: {
        handle: async (request, ctx) => {
          handledEnvelopes.push(request);
          if (request.type === "projects.list") ctx.send(responseFor(request, { projects: [] }));
        },
        disconnect: () => {},
      },
    });
    remoteHost.start();

    // Spy the uplink's wire output (ws package prototype — PWA uses native WebSocket,
    // relay runs in a child process, so only host→relay frames are captured).
    const WS = (await import("ws")).default;
    const hostOutboundRaw = [];
    const origWsSend = WS.prototype.send;
    WS.prototype.send = function patchedSend(data, ...rest) {
      try {
        const obj = JSON.parse(String(data));
        if (obj && typeof obj === "object" && typeof obj.to === "string") hostOutboundRaw.push(obj);
      } catch { /* non-JSON — ignore */ }
      return origWsSend.call(this, data, ...rest);
    };

    const cryptoMaterial = remoteHost.getRelayCryptoMaterial();
    uplink = new RelayUplink({ relayUrl: url, hostId: remoteHost.getStatus().hostId, userDataDir: userData, x25519PrivB64u: cryptoMaterial.x25519PrivB64u, x25519PubB64u: cryptoMaterial.x25519PubB64u, getHost: () => remoteHost });
    remoteHost.setRelay(uplink);
    uplink.start();
    await waitFor(() => uplink.getStatus().state === "connected", "uplink connected");

    // --- build a pairing link the way the desktop will (S3 embeds relayUrl) -----------
    const seed = randomSeedB64url();
    const identity = createDeviceIdentity(seed);
    const ticketInfo = remoteHost.createPairingTicket();
    const payloadObj = {
      hostId: ticketInfo.hostId,
      fingerprint: ticketInfo.fingerprint,
      hostPublicKeyPem: ticketInfo.hostPublicKeyPem,
      relayUrl: url,
      ticket: ticketInfo.ticket,
      expiresAt: ticketInfo.expiresAt,
      protocol: 1,
    };
    const link = `mpi://pair?payload=${Buffer.from(JSON.stringify(payloadObj)).toString("base64url")}`;

    const payload = parsePairingLink(link);
    assert.equal(payload.hostId, ticketInfo.hostId);
    assert.equal(payload.ticket, ticketInfo.ticket);
    assert.equal(payload.relayUrl, url);

    // --- full pairing through the PWA library ------------------------------------------
    const stages = [];
    const pwaOutboundRaw = []; // exact bytes the PWA puts on the wire
    const client = new RelayClient({ url, onSend: (raw) => pwaOutboundRaw.push(raw) });
    clients.push(client);
    const resultPromise = runPairing(client, payload, identity, "test-pwa", (s) => stages.push(s));

    await waitFor(() => rendererEvents.some(([ch]) => ch === "remote:pairing-request"), "desktop pairing request");
    const pairingRequest = rendererEvents.find(([ch]) => ch === "remote:pairing-request")[1];
    assert.equal(pairingRequest.deviceId, identity.deviceId); // noble deviceId accepted by the desktop
    assert.equal(remoteHost.approvePairing(pairingRequest.connectionId), true);

    const result = await resultPromise;
    assert.ok(result.deviceToken.length >= 32, "deviceToken issued");
    assert.deepEqual(stages, ["connecting", "waiting-challenge", "waiting-approval", "approved"]);

    // --- S3: E2E session established ------------------------------------------------------
    assert.equal(Buffer.from(result.hostX25519PubB64u, "base64url").length, 32, "host X25519 pub delivered (raw 32B)");
    const acceptedOnWire = hostOutboundRaw.find((f) => f.type === "pair.accepted");
    assert.ok(acceptedOnWire, "pair.accepted sent plaintext on the wire");
    assert.equal(Buffer.from(String(acceptedOnWire.payload.x25519Pub), "base64url").length, 32, "pair.accepted carries hostX25519Pub");

    // Encrypted request from the PWA: wire must be {e,n,c} only — no plaintext fields.
    const reqEnvelope = makeEnvelope("projects.list", "sess-e2e-1", {});
    // Subscribe for the response BEFORE sending (no frame buffering in RelayClient).
    const responsePromise = new Promise((resolve) => {
      const off = client.onFrame((f) => { if (f.type === "projects.list.result") { off(); resolve(f); } });
    });
    assert.equal(await client.sendData(reqEnvelope), true, "sendData accepted");
    const lastPwaWire = JSON.parse(pwaOutboundRaw[pwaOutboundRaw.length - 1]);
    assert.equal(lastPwaWire.e, 1, "device→host data frame is E2E-encrypted on the wire");
    assert.ok(typeof lastPwaWire.n === "string" && typeof lastPwaWire.c === "string", "{e,n,c} shape");
    assert.equal(lastPwaWire.type, undefined, "no plaintext envelope fields leak to the relay");

    await waitFor(() => handledEnvelopes.some((r) => r.type === "projects.list"), "host service receives decrypted projects.list");
    const seen = handledEnvelopes.find((r) => r.type === "projects.list");
    assert.equal(seen.requestId, reqEnvelope.requestId, "host decrypted the exact envelope (requestId intact)");

    // Host response comes back encrypted on the wire and is transparently decrypted by the PWA.
    await waitFor(() => hostOutboundRaw.some((f) => f.e === 1), "host→device encrypted frame on the wire");
    const encResponseOnWire = hostOutboundRaw.find((f) => f.e === 1);
    assert.equal(encResponseOnWire.type, undefined, "host response is ciphertext on the wire");
    const decResponse = await responsePromise;
    assert.equal(decResponse.requestId, reqEnvelope.requestId, "PWA decrypted the host response (requestId intact)");

    // --- reconnect through the PWA library (hello + reauthenticate) ----------------------
    client.close();
    await sleep(150);
    // identity restored from the stored seed — same deviceId/public key
    const restored = createDeviceIdentity(seed);
    assert.equal(restored.deviceId, identity.deviceId);

    const client2 = new RelayClient({ url, onSend: (raw) => pwaOutboundRaw.push(raw) });
    clients.push(client2);
    client2.setHelloCreds(identity.deviceId, result.deviceToken);
    // Subscribe BEFORE connecting so no frame can be missed (same pattern as App.tsx).
    const reResultPromise = reauthenticate(client2, payload.hostId, restored, "test-pwa");
    client2.connect();
    const reResult = await reResultPromise;
    assert.equal(reResult.deviceToken, result.deviceToken); // stable token
    assert.equal(reResult.hostX25519PubB64u, result.hostX25519PubB64u, "host X25519 pub stable across reconnects");

    // S3.4: the re-auth path re-derived the same AES key locally — encrypted traffic resumes.
    const before = handledEnvelopes.length;
    assert.equal(await client2.sendData(makeEnvelope("projects.list", "sess-e2e-2", {})), true);
    await waitFor(() => handledEnvelopes.length > before, "post-reconnect encrypted frame decrypted by host");

    WS.prototype.send = origWsSend; // restore the prototype patch
    console.log("pwa-pairing tests passed");
  } finally {
    for (const c of clients) c.close();
    uplink?.stop();
    remoteHost?.stop();
    if (relay && !relay.child.killed) relay.child.kill("SIGKILL");
    rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
