/**
 * S1 integration tests: Windows relay uplink ↔ real relay ↔ fake phone.
 *
 * Covers docs/MOBILE-DESIGN.md §5 / stage S1 acceptance:
 *   - uplink connects, registers the hostId, survives relay restarts (backoff)
 *   - createPairingTicket → ticket.register reaches the relay
 *   - full pairing chain over WSS: pair.request → pair.challenge (with
 *     connectionId) → signed pair.hello → pair.pending → approvePairing →
 *     pair.accepted carrying deviceToken; token persisted to userData dir
 *   - reconnect with stored hello(deviceToken): relay device.online → fresh
 *     challenge → trusted auto-approve, same token
 *   - relay restart: uplink backs off + reconnects, tokens re-registered so a
 *     third hello still works without full pairing
 *   - revokeDevice: relay kicks the socket (4002) and the token is dropped
 *
 * Runs the real mobile/relay prototype as a child process; electron is stubbed.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register(new URL("./electron-stub-loader.mjs", import.meta.url));

// --- relay child process (same pattern as test-relay-s0) -------------------------
/** port 0 → ephemeral; the actual port is parsed from the ready log line. */
async function startRelay(port = 0) {
  const child = spawn(process.execPath, [join(ROOT, "mobile", "relay", "index.mjs")], {
    env: { ...process.env, RELAY_PORT: String(port), RELAY_PING_MS: "500", RELAY_DEAD_MS: "1000" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let buffer = "";
  const readyPort = await new Promise((resolve, reject) => {
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
  return { child, port: readyPort };
}

// --- fake phone peer -----------------------------------------------------------------
class Phone {
  constructor(name, url) {
    this.name = name;
    this.ws = new WebSocket(url);
    this.queue = [];
    this.waiters = [];
    this.closed = null;
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`${name}: connection error`));
    });
    this.ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data));
      if (this.waiters.length) this.waiters.shift()(frame);
      else this.queue.push(frame);
    };
    this.ws.onclose = (e) => {
      this.closed = { code: e.code, reason: String(e.reason) };
    };
  }

  send(obj) {
    assert.equal(this.ws.readyState, WebSocket.OPEN, `${this.name} should be open`);
    this.ws.send(JSON.stringify(obj));
  }

  next(timeoutMs = 4_000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: no frame within ${timeoutMs}ms`)), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  async nextType(type, timeoutMs = 4_000) {
    const idx = this.queue.findIndex((frame) => frame.type === type);
    if (idx >= 0) return this.queue.splice(idx, 1)[0];
    // Hold non-matching frames aside so `next` blocks on genuinely new frames
    // (a non-match at the queue head would otherwise spin the loop forever).
    const held = this.queue.splice(0);
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const frame = await this.next(Math.max(1, deadline - Date.now()));
        if (frame.type === type) return frame;
        held.push(frame); // keep non-matches in arrival order
      }
    } finally {
      this.queue.unshift(...held.reverse()); // restore original order up front
    }
    throw new Error(`${this.name}: no ${type} within ${timeoutMs}ms`);
  }

  close(code = 1000, reason = "") {
    try {
      this.ws.close(code, reason);
    } catch { /* already closed */ }
  }
}

/** Ed25519 device identity mirroring src/main/remote/identity.ts. */
function makeDeviceIdentity() {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const deviceId = `device-${createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 24)}`;
  return {
    privateKey: pair.privateKey,
    publicKeyPem,
    deviceId,
    signText: (text) => sign(null, Buffer.from(text, "utf8"), pair.privateKey).toString("base64url"),
  };
}

async function waitFor(fn, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Sign + send pair.hello for a challenge envelope. */
function helloFor(phone, device, hostId, challengeEnvelope, ticket) {
  const p = challengeEnvelope.payload;
  phone.send({
    v: 1,
    type: "pair.hello",
    sessionId: challengeEnvelope.sessionId,
    sentAt: Date.now(),
    payload: {
      deviceId: device.deviceId,
      deviceName: "test-phone",
      publicKeyPem: device.publicKeyPem,
      signature: device.signText(`mpi-remote-v1|${hostId}|${p.connectionId}|${p.challenge}|${device.deviceId}`),
      ticket,
    },
  });
}

// --- main -------------------------------------------------------------------------------
const step = (name) => console.log(`… ${name}`);

async function main() {
  // Hard watchdog: every wait in this test is bounded; if we still live at 90s something leaked.
  setTimeout(() => {
    console.error("WATCHDOG: test exceeded 90s — aborting");
    process.exit(3);
  }, 90_000).unref();

  const userData = mkdtempSync(join(tmpdir(), "mpi-relay-uplink-"));
  let relay = null;
  const phones = [];
  let uplink = null;
  let remoteHost = null;
  try {
    // --- boot relay + host + uplink -----------------------------------------------------
    step("booting relay");
    relay = await startRelay(0);
    const url = `ws://127.0.0.1:${relay.port}/ws`;

    process.env.MPI_TEST_USER_DATA = userData;
    const { RemoteHost } = await import("../src/main/remote/host.ts");
    const { RelayUplink } = await import("../src/main/remote/relay-uplink.ts");

    const rendererEvents = [];
    const serviceCalls = { handle: 0, disconnects: [] };
    const fakeService = {
      handle: async () => { serviceCalls.handle += 1; },
      disconnect: (connectionId) => { serviceCalls.disconnects.push(connectionId); },
    };

    step("booting host + uplink");
    remoteHost = new RemoteHost({
      userDataDir: userData,
      signalingUrl: "", // WebRTC path disabled in this test
      stunUrls: [],
      sendToRenderer: (channel, payload) => rendererEvents.push([channel, payload]),
      service: fakeService,
    });
    remoteHost.start();

    const cryptoMaterial = remoteHost.getRelayCryptoMaterial();
    uplink = new RelayUplink({
      relayUrl: url,
      hostId: remoteHost.getStatus().hostId,
      userDataDir: userData,
      x25519PrivB64u: cryptoMaterial.x25519PrivB64u,
      x25519PubB64u: cryptoMaterial.x25519PubB64u,
      getHost: () => remoteHost,
    });
    remoteHost.setRelay(uplink);
    uplink.start();

    step("waiting for uplink connected");
    await waitFor(() => uplink.getStatus().state === "connected", `uplink connected (lastError=${uplink.getStatus().lastError})`);
    let health = await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).json();
    assert.equal(health.hosts, 1); // host registered on the relay
    step("uplink connected")

    // --- full pairing chain ---------------------------------------------------------------
    const device = makeDeviceIdentity();
    const ticketInfo = remoteHost.createPairingTicket();
    assert.ok(ticketInfo.ticket);

    step("starting pairing chain");
    const phone = new Phone("phone", url);
    phones.push(phone);
    await phone.opened;
    phone.send({ type: "pair.request", ticket: ticketInfo.ticket, deviceId: device.deviceId, name: "test-phone" });

    // host issues a challenge routed back to the device (carries connectionId)
    const challenge = await phone.nextType("pair.challenge");
    step("challenge received")
    assert.equal(challenge.v, 1);
    assert.match(challenge.payload.connectionId, /^relay-/);
    assert.ok(challenge.payload.challenge);

    // pending device data frames are rejected by the relay until approval (S0 rule)
    phone.send({ v: 1, type: "projects.list", sessionId: challenge.sessionId, sentAt: Date.now() });
    let f = await phone.next();
    assert.equal(f.code, "NOT_AUTHENTICATED");

    // device signs the host challenge and answers pair.hello
    helloFor(phone, device, ticketInfo.hostId, challenge, ticketInfo.ticket);
    f = await phone.nextType("pair.pending");
    assert.equal(f.payload.deviceId, device.deviceId);
    const pairingRequest = rendererEvents.find(([ch]) => ch === "remote:pairing-request");
    assert.ok(pairingRequest, "renderer got remote:pairing-request");
    assert.equal(pairingRequest[1].deviceId, device.deviceId);

    // user approves → pair.accepted carries the stable deviceToken
    const connectionId = pairingRequest[1].connectionId;
    assert.equal(remoteHost.approvePairing(connectionId), true);
    const accepted = await phone.nextType("pair.accepted");
    assert.ok(typeof accepted.payload.deviceToken === "string" && accepted.payload.deviceToken.length >= 32);
    const deviceToken = accepted.payload.deviceToken;

    // token persisted in the userData dir (survives app + relay restarts)
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(join(userData, "remote-relay-tokens.json"), "utf8"))[device.deviceId] === deviceToken;
      } catch {
        return false;
      }
    }, "token persisted");

    // --- reconnect with stored token (hello → device.online → challenge) -------------------
    phone.close(1000, "bye");
    await waitFor(() => serviceCalls.disconnects.includes(connectionId), "host saw device offline");

    const phone2 = new Phone("phone2", url);
    phones.push(phone2);
    await phone2.opened;
    phone2.send({ type: "hello", deviceId: device.deviceId, deviceToken });
    f = await phone2.next();
    assert.deepEqual(f, { type: "relay.ok", role: "device", hostId: ticketInfo.hostId });

    // trusted key → auto-approve after the signature handshake, same token
    const challenge2 = await phone2.nextType("pair.challenge");
    assert.notEqual(challenge2.payload.challenge, challenge.payload.challenge); // fresh challenge
    helloFor(phone2, device, ticketInfo.hostId, challenge2, "");
    const accepted2 = await phone2.nextType("pair.accepted");
    assert.equal(accepted2.payload.deviceToken, deviceToken); // same stable token

    // --- relay restart: uplink backs off + reconnects, tokens re-registered ------------------
    relay.child.kill("SIGKILL");
    await sleep(300);
    await waitFor(() => uplink.getStatus().state !== "connected", "uplink noticed relay death");

    const relay2 = await startRelay(relay.port); // same port → stored URL keeps working
    relay = relay2;
    await waitFor(() => uplink.getStatus().state === "connected", "uplink reconnected after relay restart");
    health = await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).json();
    assert.equal(health.hosts, 1);

    // the fresh relay has no tokens yet — the uplink re-registered them on connect,
    // so a plain hello works again without full pairing
    const phone3 = new Phone("phone3", url);
    phones.push(phone3);
    await phone3.opened;
    phone3.send({ type: "hello", deviceId: device.deviceId, deviceToken });
    f = await phone3.next();
    assert.deepEqual(f, { type: "relay.ok", role: "device", hostId: ticketInfo.hostId });
    const challenge3 = await phone3.nextType("pair.challenge");
    helloFor(phone3, device, ticketInfo.hostId, challenge3, "");
    const accepted3 = await phone3.nextType("pair.accepted");
    assert.equal(accepted3.payload.deviceToken, deviceToken);

    // --- revoke: relay kicks the socket and the token is dropped ------------------------------
    assert.equal(remoteHost.revokeDevice(device.deviceId), true);
    f = await phone3.nextType("revoked");
    assert.deepEqual(f, { type: "revoked" });
    await waitFor(() => phone3.closed?.code === 4002, "phone socket closed with REVOKED");
    await waitFor(() => {
      try {
        return !JSON.parse(readFileSync(join(userData, "remote-relay-tokens.json"), "utf8"))[device.deviceId];
      } catch {
        return true; // file gone entirely is fine too
      }
    }, "token removed after revoke");

    console.log("relay-uplink tests passed");
  } finally {
    for (const p of phones) p.close();
    uplink?.stop();
    remoteHost?.stop(); // clears ticket-cleanup timers that would keep node alive
    if (relay && !relay.child.killed) relay.child.kill("SIGKILL");
    rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
