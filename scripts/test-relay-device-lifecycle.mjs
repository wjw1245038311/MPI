/**
 * 中继设备连接生命周期（R1 + R2'）：
 *
 *   R1  同一个 socket 重复 hello 不改变路由 → **不再**通知主机 device.online。
 *       背景（2026-09-24 真机）：主机收到 device.online 会关掉并重建逻辑连接，
 *       把订阅与写租约一起清空，而设备的传输层没断、完全感知不到 → 之后所有实时
 *       事件被静默丢弃（diag `remote-pub … subs=0`）。
 *
 *   R2' host.register 带 bootId；bootId 变了 = 主机**进程**真重启了，此时主机内存里
 *       的 E2E 会话密钥已消失，旧设备连接再发也解不开 → 中继主动把它们踢掉
 *       （4007 HOST_RESTARTED），让客户端走「断线→重连→hello→挑战→认证」老路。
 *       bootId 不变（只是 uplink 网络抖动）→ 一个都不踢，不制造 churn。
 *
 * Spawns the real relay on an ephemeral port and drives it with fake host/device peers.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_ENTRY = join(ROOT, "mobile", "relay", "index.mjs");

const CLOSE_REPLACED = 4006;
const CLOSE_HOST_RESTARTED = 4007;

function startRelay() {
  const child = spawn(process.execPath, [RELAY_ENTRY], {
    env: { ...process.env, RELAY_PORT: "0", RELAY_PING_MS: "1500", RELAY_DEAD_MS: "4000" },
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

class Peer {
  constructor(name, url) {
    this.name = name;
    this.ws = new WebSocket(url);
    this.queue = [];
    this.waiters = [];
    this.closed = null;
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

  async nextType(type, timeoutMs = 3_000) {
    const idx = this.queue.findIndex((frame) => frame.type === type);
    if (idx >= 0) return this.queue.splice(idx, 1)[0];
    const held = this.queue.splice(0);
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const frame = await this.next(Math.max(1, deadline - Date.now()));
        if (frame.type === type) return frame;
        held.push(frame);
      }
    } finally {
      this.queue.unshift(...held.reverse());
    }
    throw new Error(`${this.name}: no ${type} within ${timeoutMs}ms`);
  }

  /** 断言在窗口期内**没有**收到该类型帧（用于验证「不该发生的事」）。 */
  async assertNoType(type, windowMs = 700) {
    await sleep(windowMs);
    const hit = this.queue.find((frame) => frame.type === type);
    assert.equal(hit, undefined, `${this.name}: unexpected ${type} frame arrived`);
  }

  close(code = 1000, reason = "") {
    try {
      this.ws.close(code, reason);
    } catch { /* already closed */ }
  }
}

const HOST_ID = "host-lifecycle-1";
const DEVICE_ID = "device-lifecycle-1";
const DEVICE_TOKEN = "token-lifecycle-1";
const BOOT_A = "boot-aaaa";
const BOOT_B = "boot-bbbb";

async function main() {
  const { child, ready } = startRelay();
  const peers = [];
  const connect = (name) => {
    const peer = new Peer(name, `ws://127.0.0.1:${port}/ws`);
    peers.push(peer);
    return peer;
  };
  let port = 0;
  try {
    port = await ready;

    // --- 建立一条已批准的设备记录 -------------------------------------------------
    const host1 = connect("host1");
    await host1.open();
    host1.send({ type: "host.register", hostId: HOST_ID, bootId: BOOT_A });
    await host1.nextType("relay.ok");
    host1.send({ type: "pair.approved", deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN });
    await host1.nextType("relay.ok");

    const device1 = connect("device1");
    await device1.open();
    device1.send({ type: "hello", deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, hostId: HOST_ID });
    await device1.nextType("relay.ok");
    await host1.nextType("device.online"); // 新 socket → 必须通知主机

    // --- R1：同一 socket 重复 hello 不能再通知主机 -----------------------------------
    device1.send({ type: "hello", deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, hostId: HOST_ID });
    await device1.nextType("relay.ok");
    await host1.assertNoType("device.online");
    assert.equal(device1.closed, null, "R1: 同一 socket 重复 hello 不该踢掉设备自己");
    assert.equal(host1.closed, null, "R1: 主机连接不应被重建");

    // --- 换 socket：仍然要通知主机，并顶掉旧 socket ---------------------------------
    const device2 = connect("device2");
    await device2.open();
    device2.send({ type: "hello", deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, hostId: HOST_ID });
    await device2.nextType("relay.ok");
    await host1.nextType("device.online");
    const replaced = await device1.nextType("replaced");
    assert.equal(replaced.type, "replaced");
    await sleep(200);
    assert.equal(device1.closed?.code, CLOSE_REPLACED, "换 socket 时旧 socket 应以 4006 关闭");

    // --- R2'：bootId 不变（uplink 抖动）→ 不踢设备 ---------------------------------
    const host2 = connect("host2");
    await host2.open();
    host2.send({ type: "host.register", hostId: HOST_ID, bootId: BOOT_A });
    await host2.nextType("relay.ok");
    await sleep(300);
    assert.equal(device2.closed, null, "R2': 同一 bootId（uplink 抖动）不该踢设备");

    // --- R2'：bootId 变了（主机真重启）→ 踢掉在线设备，让它重连重认证 ---------------
    const host3 = connect("host3");
    await host3.open();
    host3.send({ type: "host.register", hostId: HOST_ID, bootId: BOOT_B });
    await host3.nextType("relay.ok");
    await sleep(300);
    assert.equal(
      device2.closed?.code,
      CLOSE_HOST_RESTARTED,
      "R2': 主机换了 bootId 时在线设备应以 4007 关闭",
    );

    console.log("relay device lifecycle checks passed");
  } finally {
    for (const peer of peers) peer.close();
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
