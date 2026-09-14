/**
 * S2 end-to-end: the PWA's own library code (RelayClient + device-identity +
 * pairing) pairs with a real RemoteHost+RelayUplink through the real relay.
 *
 * Proves, among other things, that noble Ed25519 SPKI PEM / deviceId derivation
 * is byte-compatible with the desktop's identity.ts (the host verifies it).
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

    // --- unit: parsePairingLink ------------------------------------------------------
    assert.throws(() => parsePairingLink(""));
    assert.throws(() => parsePairingLink("mpi://pair?payload=!!!not-base64-json"));
    const parsedBare = parsePairingLink(Buffer.from(JSON.stringify({ hostId: "h", ticket: "t" })).toString("base64url"));
    assert.equal(parsedBare.hostId, "h");

    // --- boot host + uplink -----------------------------------------------------------
    const rendererEvents = [];
    remoteHost = new RemoteHost({
      userDataDir: userData,
      signalingUrl: "",
      stunUrls: [],
      sendToRenderer: (channel, payload) => rendererEvents.push([channel, payload]),
      service: { handle: async () => {}, disconnect: () => {} },
    });
    remoteHost.start();
    uplink = new RelayUplink({ relayUrl: url, hostId: remoteHost.getStatus().hostId, userDataDir: userData, getHost: () => remoteHost });
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
    const client = new RelayClient({ url });
    clients.push(client);
    const resultPromise = runPairing(client, payload, identity, "test-pwa", (s) => stages.push(s));

    await waitFor(() => rendererEvents.some(([ch]) => ch === "remote:pairing-request"), "desktop pairing request");
    const pairingRequest = rendererEvents.find(([ch]) => ch === "remote:pairing-request")[1];
    assert.equal(pairingRequest.deviceId, identity.deviceId); // noble deviceId accepted by the desktop
    assert.equal(remoteHost.approvePairing(pairingRequest.connectionId), true);

    const result = await resultPromise;
    assert.ok(result.deviceToken.length >= 32, "deviceToken issued");
    assert.deepEqual(stages, ["connecting", "waiting-challenge", "waiting-approval", "approved"]);

    // --- reconnect through the PWA library (hello + reauthenticate) ----------------------
    client.close();
    await sleep(150);
    // identity restored from the stored seed — same deviceId/public key
    const restored = createDeviceIdentity(seed);
    assert.equal(restored.deviceId, identity.deviceId);

    const client2 = new RelayClient({ url });
    clients.push(client2);
    client2.setHelloCreds(identity.deviceId, result.deviceToken);
    // Subscribe BEFORE connecting so no frame can be missed (same pattern as App.tsx).
    const reResultPromise = reauthenticate(client2, payload.hostId, restored, "test-pwa");
    client2.connect();
    const reResult = await reResultPromise;
    assert.equal(reResult.deviceToken, result.deviceToken); // stable token

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
