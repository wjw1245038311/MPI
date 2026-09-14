/**
 * S4 end-to-end: PWA home session layer (lib/session.ts) against a real relay +
 * real RemoteHost/RelayUplink with a fake host service.
 *
 * Covers: request/response correlation (requestId routing, out-of-order replies),
 * projects/threads caching, running-thread polling cadence (start & stop), and
 * mid-session socket drop → auto-reconnect + attachAutoReauth + data refetch.
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
  const userData = mkdtempSync(join(tmpdir(), "mpi-pwa-home-"));
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
    const { createDeviceIdentity, randomSeedB64url } = await import("../mobile/pwa/src/lib/device-identity.ts");
    const { parsePairingLink, runPairing, attachAutoReauth } = await import("../mobile/pwa/src/lib/pairing.ts");
    const { RelayClient } = await import("../mobile/pwa/src/lib/relay-client.ts");
    const { HostSession } = await import("../mobile/pwa/src/lib/session.ts");
    const { responseFor } = await import("../mobile/shared/protocol.ts");

    // --- fake host service: two projects, one running thread -------------------------
    const now = Date.now();
    const projects = [
      { id: "p1", name: "Alpha", threadCount: 2, updatedAt: now - 60_000 },
      { id: "p2", name: "Beta", threadCount: 0, updatedAt: now - 3_600_000 },
    ];
    const threadData = {
      p1: [
        { id: "t1", projectId: "p1", title: "Running task", preview: "doing things", updatedAt: now, messageCount: 5, state: "running", permission: "sandbox" },
        { id: "t2", projectId: "p1", title: "Idle task", preview: "done long ago", updatedAt: now - 60_000, messageCount: 9, state: "idle", permission: "full" },
      ],
      p2: [],
    };
    const threadsListCalls = { p1: 0, p2: 0 };

    const rendererEvents = [];
    remoteHost = new RemoteHost({
      userDataDir: userData,
      signalingUrl: "",
      stunUrls: [],
      sendToRenderer: (channel, payload) => rendererEvents.push([channel, payload]),
      service: {
        handle: async (request, ctx) => {
          if (request.type === "projects.list") {
            ctx.send(responseFor(request, { projects }));
            return;
          }
          if (request.type === "threads.list") {
            const pid = String(request.payload.projectId);
            threadsListCalls[pid] += 1;
            if (pid === "p1") await sleep(60); // force out-of-order replies vs p2
            ctx.send(responseFor(request, { threads: threadData[pid] ?? [] }));
          }
        },
        disconnect: () => {},
      },
    });
    remoteHost.start();

    const cryptoMaterial = remoteHost.getRelayCryptoMaterial();
    uplink = new RelayUplink({ relayUrl: url, hostId: remoteHost.getStatus().hostId, userDataDir: userData, x25519PrivB64u: cryptoMaterial.x25519PrivB64u, x25519PubB64u: cryptoMaterial.x25519PubB64u, getHost: () => remoteHost });
    remoteHost.setRelay(uplink);
    uplink.start();
    await waitFor(() => uplink.getStatus().state === "connected", "uplink connected");

    // --- S8: data frames must never go out plaintext before E2E -----------------------
    {
      const bare = new RelayClient({ url });
      clients.push(bare);
      assert.equal(
        await bare.sendData({ v: 1, type: "projects.list", sessionId: "s0" }),
        false,
        "sendData fails fast without an E2E session (no plaintext data frames)",
      );
    }

    // --- pair (same flow as the S2/S3 test) -------------------------------------------
    const seed = randomSeedB64url();
    const identity = createDeviceIdentity(seed);
    const ticketInfo = remoteHost.createPairingTicket();
    const link = `mpi://pair?payload=${Buffer.from(JSON.stringify({ hostId: ticketInfo.hostId, fingerprint: ticketInfo.fingerprint, hostPublicKeyPem: ticketInfo.hostPublicKeyPem, relayUrl: url, ticket: ticketInfo.ticket, expiresAt: ticketInfo.expiresAt, protocol: 1 })).toString("base64url")}`;
    const payload = parsePairingLink(link);

    const client = new RelayClient({ url });
    clients.push(client);
    const resultPromise = runPairing(client, payload, identity, "test-pwa-home");
    await waitFor(() => rendererEvents.some(([ch]) => ch === "remote:pairing-request"), "desktop pairing request");
    const pairingRequest = rendererEvents.find(([ch]) => ch === "remote:pairing-request")[1];
    assert.equal(remoteHost.approvePairing(pairingRequest.connectionId), true);
    const result = await resultPromise;
    client.setHelloCreds(identity.deviceId, result.deviceToken);

    // --- S4.1: session layer — lists, correlation, online state ------------------------
    let reauthCount = 0;
    const session = new HostSession(client, { pollIntervalMs: 100, requestTimeoutMs: 3_000 });
    attachAutoReauth(client, payload.hostId, identity, "test-pwa-home", () => {
      reauthCount += 1;
      void session.refresh(); // post-reauth refetch (the open-triggered one may race AUTH_REQUIRED)
    });

    await session.refresh();
    const snap = session.getSnapshot();
    assert.deepEqual(snap.projects.map((p) => p.id), ["p1", "p2"], "projects cached");
    assert.equal(snap.threadsByProject.p1.length, 2, "p1 threads cached (out-of-order reply still routed by requestId)");
    assert.deepEqual(snap.threadsByProject.p1.map((t) => t.id), ["t1", "t2"], "thread order intact — no reqId cross-wiring");
    assert.deepEqual(snap.threadsByProject.p2, [], "p2 empty list cached");
    assert.equal(snap.hostOnline, true);
    assert.ok(typeof snap.lastFrameAt === "number" && snap.lastFrameAt > 0, "lastFrameAt tracked");
    assert.equal(snap.error, null);

    // --- S4.3: polling while a thread is running ---------------------------------------
    const callsBefore = threadsListCalls.p1;
    await sleep(450); // ~4 poll cycles at 100ms
    assert.ok(threadsListCalls.p1 - callsBefore >= 2, `running project polled repeatedly (delta=${threadsListCalls.p1 - callsBefore})`);

    threadData.p1 = threadData.p1.map((t) => ({ ...t, state: "idle" })); // everything settles
    await waitFor(() => session.getSnapshot().threadsByProject.p1.every((t) => t.state === "idle"), "poll picks up idle state");
    const settledCalls = threadsListCalls.p1;
    await sleep(350);
    assert.equal(threadsListCalls.p1, settledCalls, "polling stops once no thread is running");

    // --- mid-session drop: auto-reconnect + reauth + refetch ----------------------------
    client.simulateDrop();
    await waitFor(() => session.getSnapshot().hostOnline === false, "session sees the drop");
    await waitFor(
      () => session.getSnapshot().hostOnline && session.getSnapshot().error === null && session.getSnapshot().projects.length === 2,
      "reconnect + reauth + refetch",
      15_000,
    );
    assert.ok(reauthCount >= 1, `attachAutoReauth answered the post-drop challenge (count=${reauthCount})`);
    // A fresh request after reconnect proves E2E crypto was reinstalled.
    await session.refresh();
    assert.equal(session.getSnapshot().error, null, "post-reconnect traffic still decrypts");

    // --- S8: replaced device — a second connection with the same identity takes over;
    // the first must stop (no auto-reconnect → no ping-pong loop between two tabs).
    const client2 = new RelayClient({ url });
    clients.push(client2);
    client2.setHelloCreds(identity.deviceId, result.deviceToken);
    client2.connect();
    await waitFor(() => client.getState() === "closed", "first client replaced by second connection", 10_000);
    assert.equal(client.getLastError(), "REPLACED", "replacement surfaced as REPLACED error");
    // Longer than the base backoff (1s): a buggy reconnect would fire within this window.
    await sleep(1_500);
    assert.equal(client.getState(), "closed", "replaced client does not auto-reconnect");
    assert.equal(client2.getState(), "open", "second connection stays open");

    console.log("pwa-home tests passed");
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
