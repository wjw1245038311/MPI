/**
 * S0 acceptance tests for the mobile cloud relay prototype (mobile/relay).
 *
 * Covers docs/MOBILE-DESIGN.md §12.4 checkpoints:
 *   S0.1 registration + routing table, /healthz online counts
 *   S0.2 opaque frame forwarding both directions, offline events on peer death
 *   S0.3 ticket.register / pair.request routing skeleton (one-shot, TTL, multi-host)
 *
 * Spawns the real relay on an ephemeral port with fast heartbeat env and drives
 * it with fake host/phone peers using Node's built-in WebSocket client.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_ENTRY = join(ROOT, "mobile", "relay", "index.mjs");

// --- relay child process ---------------------------------------------------------
function startRelay() {
  const child = spawn(process.execPath, [RELAY_ENTRY], {
    env: { ...process.env, RELAY_PORT: "0", RELAY_PING_MS: "500", RELAY_DEAD_MS: "1000" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let buffer = "";
  const ready = new Promise((resolve, reject) => {
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
  return { child, ready };
}

// --- fake peer ---------------------------------------------------------------------
class Peer {
  constructor(name, url) {
    this.name = name;
    this.ws = new WebSocket(url);
    this.queue = [];
    this.waiters = [];
    this.closed = null; // { code, reason }
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`${this.name}: connection error`));
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

  open() {
    return this.opened;
  }

  send(obj) {
    assert.equal(this.ws.readyState, WebSocket.OPEN, `${this.name} should be open`);
    this.ws.send(JSON.stringify(obj));
  }

  next(timeoutMs = 3_000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: no frame within ${timeoutMs}ms`)), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  /** Wait for a frame with the given type, skipping others (which are re-queued). */
  async nextType(type, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await this.next(deadline - Date.now());
      if (frame.type === type) return frame;
      this.queue.unshift(frame);
    }
  }

  close(code = 1000, reason = "") {
    try {
      this.ws.close(code, reason);
    } catch { /* already closed */ }
  }
}

const envelope = (type, sessionId, extra = {}) => ({ v: 1, type, sessionId, sentAt: Date.now(), ...extra });

// --- main ----------------------------------------------------------------------------
async function main() {
  const { child, ready } = startRelay();
  const peers = [];
  try {
    const port = await ready;
    const url = `ws://127.0.0.1:${port}/ws`;
    const healthz = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();

    // --- S0.1: empty routing table -------------------------------------------------
    let h = await healthz();
    assert.equal(h.ok, true);
    assert.equal(h.hosts, 0);
    assert.equal(h.devices, 0);

    const connect = async (name) => {
      const p = new Peer(name, url);
      peers.push(p);
      await p.open();
      return p;
    };

    const host1 = await connect("host1");
    host1.send({ type: "host.register", hostId: "h1" });
    let f = await host1.next();
    assert.deepEqual(f, { type: "relay.ok", role: "host" });

    h = await healthz();
    assert.equal(h.hosts, 1);

    // --- S0.3: ticket + pair.request routing ----------------------------------------
    host1.send({ type: "ticket.register", ticket: "t1", expiresAt: Date.now() + 60_000 });
    f = await host1.next();
    assert.equal(f.type, "relay.ok");

    const phoneA = await connect("phoneA");
    const pairReq = { type: "pair.request", ticket: "t1", deviceId: "device-a", name: "phoneA" };
    phoneA.send(pairReq);
    f = await host1.next();
    assert.deepEqual(f, pairReq); // relay forwards the frame unchanged to the right host

    // pending device may not send data frames before approval
    phoneA.send(envelope("projects.list", "s1"));
    f = await phoneA.next();
    assert.equal(f.type, "relay.error");
    assert.equal(f.code, "NOT_AUTHENTICATED");

    host1.send({ type: "pair.approved", deviceId: "device-a", deviceToken: "tok-abc" });
    f = await host1.next();
    assert.deepEqual(f, { type: "relay.ok", role: "host", deviceId: "device-a" });

    // --- S0.2: opaque forwarding both directions --------------------------------------
    const up = envelope("projects.list", "s1", { requestId: "r1" });
    phoneA.send(up);
    f = await host1.next();
    assert.deepEqual(f, up); // device → host unchanged

    const down = envelope("projects.list.result", "s1", { requestId: "r1", payload: { ok: true } }, );
    host1.send({ to: "device-a", ...down });
    f = await phoneA.next();
    assert.deepEqual(f, { to: "device-a", ...down }); // host → device unchanged (incl. `to`)

    host1.send(envelope("projects.list", "s1")); // no `to`
    f = await host1.next();
    assert.equal(f.code, "NO_ROUTE");
    host1.send({ to: "device-x", v: 1, type: "x", sessionId: "s1", sentAt: Date.now() });
    f = await host1.next();
    assert.equal(f.code, "UNKNOWN_DEVICE");

    // --- S0.3: ticket one-shot / expiry / unknown --------------------------------------
    const phoneB = await connect("phoneB");
    phoneB.send({ type: "pair.request", ticket: "t1", deviceId: "device-b" });
    f = await phoneB.next();
    assert.equal(f.code, "TICKET_INVALID"); // already used

    host1.send({ type: "ticket.register", ticket: "t2", expiresAt: Date.now() + 300 });
    await host1.next();
    await sleep(450);
    const phoneC = await connect("phoneC");
    phoneC.send({ type: "pair.request", ticket: "t2", deviceId: "device-c" });
    f = await phoneC.next();
    assert.equal(f.code, "TICKET_EXPIRED");

    const phoneD = await connect("phoneD");
    phoneD.send({ type: "pair.request", ticket: "nope", deviceId: "device-d" });
    f = await phoneD.next();
    assert.equal(f.code, "TICKET_INVALID");

    // --- S0.3: multi-host routing --------------------------------------------------------
    const host2 = await connect("host2");
    host2.send({ type: "host.register", hostId: "h2" });
    await host2.next();
    host2.send({ type: "ticket.register", ticket: "t3", expiresAt: Date.now() + 60_000 });
    await host2.next();

    const phoneE = await connect("phoneE");
    const pairReqE = { type: "pair.request", ticket: "t3", deviceId: "device-e" };
    phoneE.send(pairReqE);
    f = await host2.next();
    assert.deepEqual(f, pairReqE); // arrived at h2…
    assert.equal(host1.queue.length, 0); // …and not at h1

    host2.send({ type: "pair.approved", deviceId: "device-e", deviceToken: "tok-e" });
    f = await host2.next();
    assert.deepEqual(f, { type: "relay.ok", role: "host", deviceId: "device-e" });

    const upE = envelope("projects.list", "s1");
    phoneE.send(upE);
    f = await host2.next();
    assert.deepEqual(f, upE); // approved device on h2 forwards while the host is alive

    // --- S0.3: hello re-auth with stored token ---------------------------------------------
    const phoneF = await connect("phoneF");
    phoneF.send({ type: "hello", deviceId: "device-a", deviceToken: "tok-abc" });
    f = await phoneF.next();
    assert.deepEqual(f, { type: "relay.ok", role: "device", hostId: "h1" });

    // the previous socket for the same device is replaced
    f = await phoneA.nextType("replaced");
    assert.equal(f.type, "replaced");
    await sleep(50);
    assert.equal(phoneA.closed?.code, 4006);

    const up2 = envelope("threads.list", "s1", { requestId: "r2" });
    phoneF.send(up2);
    f = await host1.next();
    assert.deepEqual(f, up2); // re-hello'd socket can forward data

    // --- S0.2: offline events on peer death -------------------------------------------------
    phoneF.close(1000, "bye"); // device side goes away
    f = await host1.nextType("offline");
    assert.deepEqual(f, { type: "offline", who: "device", deviceId: "device-a" });

    host2.close(1000, "bye"); // host side dies → its devices are notified
    f = await phoneE.nextType("offline");
    assert.deepEqual(f, { type: "offline", who: "host", hostId: "h2" });

    // data frames to a dead host bounce back as HOST_OFFLINE
    phoneE.send(envelope("projects.list", "s1"));
    f = await phoneE.next();
    assert.equal(f.code, "HOST_OFFLINE");

    h = await healthz();
    assert.equal(h.hosts, 1); // only h1 remains
    assert.equal(h.devices, 1); // phoneE socket still connected (bound to dead host)

    console.log("relay-s0 tests passed");
  } finally {
    for (const p of peers) p.close();
    child.kill("SIGTERM");
    await sleep(200);
    if (!child.killed) child.kill("SIGKILL");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
