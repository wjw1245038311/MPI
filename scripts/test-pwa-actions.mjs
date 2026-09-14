/**
 * S6 end-to-end: PWA send control (lib/thread-actions.ts) + approval card state
 * (ThreadSession pendingUi) against a real relay + real RemoteHost/RelayUplink,
 * with the REAL RemoteService (claim/assertWriter semantics) over a fake backend.
 *
 * Part 1 (in-process units):
 *   - RemoteService claim: A claims → B's claimWrite/prompt get THREAD_BUSY
 *   - ThreadActions retry policy via fake transport: WRITE_CLAIM_REQUIRED →
 *     re-claim + retry once; THREAD_BUSY → no auto-retry, error surfaces
 * Part 2 (full stack over relay + E2E):
 *   - prompt/steer/followUp/abort/setPermission reach the backend in order
 *   - host lease expiry (500ms) → WRITE_CLAIM_REQUIRED → silent re-claim + retry
 *   - ui.request push (with §4.5 diff field) → pendingUi card; duplicate push
 *     does not re-pop; respondUi delivers {value}/{confirmed} to the backend;
 *     markUiResponded clears + dedupes later re-pushes
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

// ---------------------------------------------------------------------------
// Part 1: in-process units against the REAL RemoteService claim logic.
// ---------------------------------------------------------------------------
async function part1Units() {
  process.env.MPI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), "mpi-pwa-actions-"));
  const { RemoteService } = await import("../src/main/remote/service.ts");
  const { makeEnvelope, responseFor } = await import("../mobile/shared/protocol.ts");
  const { ThreadActions } = await import("../mobile/pwa/src/lib/thread-actions.ts");

  const T = "thread-unit";
  const calls = [];
  const backend = {
    listProjects: async () => [],
    listThreads: async () => [],
    getThread: async () => ({ id: T }),
    createThread: async () => ({}),
    setPermission: async (id, p) => { calls.push(["setPermission", id, p]); return {}; },
    setModel: async () => ({}),
    prompt: async (id, text) => { calls.push(["prompt", id, text]); return {}; },
    steer: async (id, text) => { calls.push(["steer", id, text]); return {}; },
    followUp: async (id, text) => { calls.push(["followUp", id, text]); return {}; },
    abort: async (id) => { calls.push(["abort", id]); return {}; },
    fileTree: async () => [],
    filePreview: async () => null,
    respondUi: async (id, reqId, payload) => { calls.push(["respondUi", id, reqId, payload]); return {}; },
    subscribeThread: () => () => {},
  };

  // --- RemoteService: A claims → B is busy ---------------------------------
  const svc = new RemoteService(backend, { leaseMs: 60_000 });
  let n = 0;
  const env = (type) => ({ ...makeEnvelope(type, "sess-unit", {}, { requestId: `u-${++n}` }), threadId: T });

  let outA;
  await svc.handle(env("thread.claimWrite"), { connectionId: "conn-A", deviceId: "dev-1", send: (m) => (outA = m) });
  assert.equal(outA.error, undefined, "A's claim succeeds");

  let outB;
  await svc.handle(env("thread.claimWrite"), { connectionId: "conn-B", deviceId: "dev-2", send: (m) => (outB = m) });
  assert.equal(outB?.error?.code, "THREAD_BUSY", "B's claim is rejected while A holds the lease");

  outB = undefined;
  await svc.handle(env("thread.prompt"), { connectionId: "conn-B", deviceId: "dev-2", send: (m) => (outB = m) });
  assert.equal(outB?.error?.code, "THREAD_BUSY", "B's prompt is rejected too");

  // --- ThreadActions retry policy via a fake transport ----------------------
  function makeFakeTransport(script) {
    const sent = [];
    let frameSink = null;
    return {
      sent,
      client: {
        sendData(envelope) {
          sent.push(envelope);
          const reply = script(envelope, sent.length);
          if (reply && frameSink) setTimeout(() => frameSink(reply), 0);
          return true;
        },
        onFrame(listener) {
          frameSink = listener;
          return () => { frameSink = null; };
        },
        isOpen: () => true,
      },
    };
  }

  // WRITE_CLAIM_REQUIRED on prompt → re-claim once + retry (2 prompts total).
  {
    let promptCount = 0;
    const fake = makeFakeTransport((envelope) => {
      if (envelope.type === "thread.claimWrite") return responseFor(envelope, {});
      if (envelope.type === "thread.prompt") {
        promptCount += 1;
        // first prompt attempt: host says our lease expired
        if (promptCount === 1) {
          return { ...responseFor(envelope, {}), payload: undefined, error: { code: "WRITE_CLAIM_REQUIRED", message: "Claim the thread before writing" } };
        }
      }
      return responseFor(envelope, {});
    });
    const actions = new ThreadActions(fake.client, T, { requestTimeoutMs: 2_000 });
    await actions.send("hello", "prompt");
    assert.deepEqual(
      fake.sent.map((e) => e.type),
      ["thread.claimWrite", "thread.prompt", "thread.claimWrite", "thread.prompt"],
      "WRITE_CLAIM_REQUIRED → re-claim + retry exactly once",
    );
  }

  // THREAD_BUSY on prompt → no auto-retry, error surfaces to the caller.
  {
    const fake = makeFakeTransport((envelope) => {
      if (envelope.type === "thread.claimWrite") return responseFor(envelope, {});
      return { ...responseFor(envelope, {}), payload: undefined, error: { code: "THREAD_BUSY", message: "Thread is being edited by another device" } };
    });
    const actions = new ThreadActions(fake.client, T, { requestTimeoutMs: 2_000 });
    await assert.rejects(
      () => actions.send("hello", "prompt"),
      (e) => e.message.startsWith("THREAD_BUSY:"),
      "THREAD_BUSY surfaces without auto-retry",
    );
    const prompts = fake.sent.filter((e) => e.type === "thread.prompt");
    assert.equal(prompts.length, 1, "no retry after THREAD_BUSY");
  }

  console.log("part1 (service claims + actions retry policy): passed");
}

// ---------------------------------------------------------------------------
// Part 2: full stack — relay + uplink + E2E + real RemoteService.
// ---------------------------------------------------------------------------
async function part2FullStack() {
  const userData = mkdtempSync(join(tmpdir(), "mpi-pwa-actions-"));
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
    const { RemoteService } = await import("../src/main/remote/service.ts");
    const { createDeviceIdentity, randomSeedB64url } = await import("../mobile/pwa/src/lib/device-identity.ts");
    const { parsePairingLink, runPairing, attachAutoReauth } = await import("../mobile/pwa/src/lib/pairing.ts");
    const { RelayClient } = await import("../mobile/pwa/src/lib/relay-client.ts");
    const { ThreadSession } = await import("../mobile/pwa/src/lib/thread-session.ts");
    const { ThreadActions } = await import("../mobile/pwa/src/lib/thread-actions.ts");

    // --- fake backend behind the REAL RemoteService (short lease for tests) ----
    const T = "thread-abc";
    const calls = [];
    let threadListener = null;
    const makeSnapshot = () => ({
      id: T, projectId: "p1", title: "Actions thread", preview: "", updatedAt: Date.now(),
      messageCount: 0, state: "idle", permission: "sandbox",
      cwdName: "demo", model: null, availableModels: [], skills: [], thinkingLevel: "off",
      messages: [], nextSeq: 1,
    });
    const backend = {
      listProjects: async () => [{ id: "p1", name: "Demo", threadCount: 1, updatedAt: Date.now() }],
      listThreads: async () => [makeSnapshot()],
      getThread: async () => makeSnapshot(),
      createThread: async () => makeSnapshot(),
      setPermission: async (id, p) => { calls.push(["setPermission", id, p]); return makeSnapshot(); },
      setModel: async () => makeSnapshot(),
      prompt: async (id, text) => { calls.push(["prompt", id, text]); return {}; },
      steer: async (id, text) => { calls.push(["steer", id, text]); return {}; },
      followUp: async (id, text) => { calls.push(["followUp", id, text]); return {}; },
      abort: async (id) => { calls.push(["abort", id]); return {}; },
      fileTree: async () => [],
      filePreview: async () => null,
      respondUi: async (id, reqId, payload) => { calls.push(["respondUi", id, reqId, payload]); return {}; },
      subscribeThread: (id, listener) => { threadListener = listener; return () => { if (threadListener === listener) threadListener = null; }; },
    };

    const rendererEvents = [];
    remoteHost = new RemoteHost({
      userDataDir: userData,
      signalingUrl: "",
      stunUrls: [],
      sendToRenderer: (channel, payload) => rendererEvents.push([channel, payload]),
      service: new RemoteService(backend, { leaseMs: 500 }), // short lease → expiry path is testable
    });
    remoteHost.start();

    const cryptoMaterial = remoteHost.getRelayCryptoMaterial();
    uplink = new RelayUplink({ relayUrl: url, hostId: remoteHost.getStatus().hostId, userDataDir: userData, x25519PrivB64u: cryptoMaterial.x25519PrivB64u, x25519PubB64u: cryptoMaterial.x25519PubB64u, getHost: () => remoteHost });
    remoteHost.setRelay(uplink);
    uplink.start();
    await waitFor(() => uplink.getStatus().state === "connected", "uplink connected");

    // --- pair -------------------------------------------------------------------
    const seed = randomSeedB64url();
    const identity = createDeviceIdentity(seed);
    const ticketInfo = remoteHost.createPairingTicket();
    const link = `mpi://pair?payload=${Buffer.from(JSON.stringify({ hostId: ticketInfo.hostId, fingerprint: ticketInfo.fingerprint, hostPublicKeyPem: ticketInfo.hostPublicKeyPem, relayUrl: url, ticket: ticketInfo.ticket, expiresAt: ticketInfo.expiresAt, protocol: 1 })).toString("base64url")}`;
    const payload = parsePairingLink(link);

    const client = new RelayClient({ url });
    clients.push(client);
    const resultPromise = runPairing(client, payload, identity, "test-pwa-actions");
    await waitFor(() => rendererEvents.some(([ch]) => ch === "remote:pairing-request"), "desktop pairing request");
    const pairingRequest = rendererEvents.find(([ch]) => ch === "remote:pairing-request")[1];
    assert.equal(remoteHost.approvePairing(pairingRequest.connectionId), true);
    const result = await resultPromise;
    client.setHelloCreds(identity.deviceId, result.deviceToken);

    // --- open the thread (real service subscribe) ---------------------------------
    const ts = new ThreadSession(client, T, { requestTimeoutMs: 3_000 });
    attachAutoReauth(client, payload.hostId, identity, "test-pwa-actions", () => {
      void ts.resync().catch(() => {});
    });
    await ts.open();
    assert.equal(ts.getSnapshot().ready, true);
    assert.ok(threadListener, "backend subscriber registered via real service");

    const claims = [];
    const actions = new ThreadActions(client, T, { requestTimeoutMs: 3_000, onClaim: () => claims.push(Date.now()) });

    // A. prompt reaches the backend (success proves the real assertWriter accepted our claim)
    await actions.send("hello", "prompt");
    assert.deepEqual(calls.at(-1), ["prompt", T, "hello"]);
    assert.equal(claims.length, 1, "initial claim fired onClaim");

    // B. lease expiry (host 500ms < local default 30s) → WRITE_CLAIM_REQUIRED → silent re-claim + retry
    await sleep(650);
    await actions.send("steer me", "steer");
    assert.deepEqual(calls.at(-1), ["steer", T, "steer me"]);
    assert.equal(claims.length, 2, "expired lease was re-claimed transparently");

    // C. followUp / abort / setPermission all pass the writer gate
    await actions.send("after that", "followUp");
    assert.deepEqual(calls.at(-1), ["followUp", T, "after that"]);
    await actions.abort();
    assert.deepEqual(calls.at(-1), ["abort", T]);
    await actions.setPermission("full");
    assert.deepEqual(calls.at(-1), ["setPermission", T, "full"]);

    // D. ui.request with §4.5 diff → pendingUi card; duplicate push does not re-pop
    const diff = { path: "src/a.ts", added: 2, removed: 1, hunks: "@@ -1,3 +1,4 @@\n line1\n-line2\n+CHANGED\n+line5" };
    const uiRequest = {
      id: "ui-1", method: "select",
      title: "Permission required: write\nStrict mode: every file write or edit requires confirmation.\n\n{\"path\":\"src/a.ts\"}",
      options: ["仅允许本次", "拒绝"],
      diff,
    };
    let viewUpdates = 0;
    const detachView = ts.subscribe(() => { viewUpdates += 1; });

    threadListener({ kind: "ui.request", data: { request: uiRequest } });
    await waitFor(() => ts.getSnapshot().pendingUi?.id === "ui-1", "approval card appears");
    assert.deepEqual(ts.getSnapshot().pendingUi.diff, diff, "diff field survives relay + E2E");

    const updatesBeforeDup = viewUpdates;
    threadListener({ kind: "ui.request", data: { request: uiRequest } }); // duplicate push
    await sleep(150);
    assert.equal(viewUpdates, updatesBeforeDup, "duplicate ui.request does not re-pop the card");

    // E. respond → real service writer gate → backend gets the exact response shape
    await actions.respondUi("ui-1", { value: "仅允许本次" });
    assert.deepEqual(calls.at(-1), ["respondUi", T, "ui-1", { value: "仅允许本次" }]);

    // F. markUiResponded clears the card and dedupes later re-pushes of the same id
    ts.markUiResponded("ui-1");
    assert.equal(ts.getSnapshot().pendingUi, null);
    threadListener({ kind: "ui.request", data: { request: uiRequest } }); // late duplicate after answering
    await sleep(150);
    assert.equal(ts.getSnapshot().pendingUi, null, "answered id never re-pops");

    // G. a second request without diff (confirm) also flows through
    threadListener({ kind: "ui.request", data: { request: { id: "ui-2", method: "confirm", title: "确认执行？" } } });
    await waitFor(() => ts.getSnapshot().pendingUi?.id === "ui-2", "second approval card appears");
    assert.equal(ts.getSnapshot().pendingUi.diff, undefined, "no diff field for non-write approvals");
    await actions.respondUi("ui-2", { confirmed: true });
    assert.deepEqual(calls.at(-1), ["respondUi", T, "ui-2", { confirmed: true }]);
    ts.markUiResponded("ui-2");

    detachView();
    console.log("part2 (full stack over relay + E2E): passed");
  } finally {
    for (const c of clients) c.close();
    uplink?.stop();
    remoteHost?.stop();
    if (relay && !relay.child.killed) relay.child.kill("SIGKILL");
    rmSync(userData, { recursive: true, force: true });
  }
}

await part1Units();
await part2FullStack();
console.log("pwa-actions tests passed");
process.exit(0);
