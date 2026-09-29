/**
 * E2E 二进制帧（2026-09-30）：去掉 base64 的 33% 膨胀。
 *
 * 三件事必须钉住：
 *   ① 帧布局（版本/头长/JSON 头/nonce‖密文‖tag）往返一致，且**能解回明文**——布局错一个字节
 *      的表现是「所有加密流量静默解不开」，现场极难归因；
 *   ② 畸形帧一律返回 null（不能把垃圾当帧解、更不能崩）；
 *   ③ 中继的路由与 JSON 版**同规矩**：设备未批准 → NOT_AUTHENTICATED；目标设备不在线 → DEVICE_OFFLINE。
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  E2E_BINARY_CAP,
  E2E_BINARY_VERSION,
  decodeBinaryFrame,
  decryptFrameRaw,
  encodeBinaryFrame,
  encryptFrameRaw,
  supportsBinaryFrames,
} = await import("../src/main/remote/e2e-binary.ts");

// ---- 1. 编解码往返（含真加密）------------------------------------------------
{
  const key = randomBytes(32);
  const plaintext = JSON.stringify({ type: "thread.prompt", payload: { text: "你好" } });
  const frame = encryptFrameRaw(key, plaintext);
  const encoded = encodeBinaryFrame({ to: "device-abc" }, frame);
  assert.equal(encoded[0], E2E_BINARY_VERSION, "第一字节是版本");
  assert.ok(encoded.length < JSON.stringify({ e: 1, n: frame.nonce.toString("base64url"), c: frame.body.toString("base64url") }).length, "二进制应比 base64 JSON 小");

  const decoded = decodeBinaryFrame(encoded);
  assert.ok(decoded, "应能解回");
  assert.deepEqual(decoded.header, { to: "device-abc" }, "头部往返一致");
  assert.equal(decryptFrameRaw(key, decoded.frame.nonce, decoded.frame.body), plaintext, "解出的明文必须一致");

  // 空头部（设备→主机不需要 to，中继会补 from）
  const bare = encodeBinaryFrame({}, frame);
  assert.deepEqual(decodeBinaryFrame(bare)?.header, {}, "空头部也要能往返");

  // 尺寸对比：base64 的 33% 膨胀确实被省掉了
  const payload = randomBytes(300 * 1024);
  const big = Buffer.concat([randomBytes(12), payload, randomBytes(16)]);
  const base64Json = Buffer.byteLength(JSON.stringify({ e: 1, n: big.subarray(0, 12).toString("base64url"), c: big.subarray(12).toString("base64url") }), "utf8");
  const binary = encodeBinaryFrame({ to: "device-abc" }, { nonce: big.subarray(0, 12), body: big.subarray(12) });
  const saving = (1 - binary.length / base64Json) * 100;
  assert.ok(saving > 20 && saving < 30, `二进制相对 base64 JSON 应省 ~25%（实测 ${saving.toFixed(1)}%）`);
  console.log(`ok 1 - 编解码往返 + 明文可解 + 省掉 ${saving.toFixed(1)}% 字节`);
}

// ---- 2. 畸形帧不能当帧解 -----------------------------------------------------
{
  assert.equal(decodeBinaryFrame(Buffer.alloc(0)), null, "空");
  assert.equal(decodeBinaryFrame(Buffer.from([1])), null, "只有版本");
  assert.equal(decodeBinaryFrame(Buffer.from([2, 0, ...randomBytes(40)])), null, "版本不对");
  assert.equal(decodeBinaryFrame(Buffer.from([1, 200, ...randomBytes(10)])), null, "头长超出实际长度");
  const badHeader = Buffer.concat([Buffer.from([1, 3]), Buffer.from("{x]", "utf8"), randomBytes(40)]);
  assert.equal(decodeBinaryFrame(badHeader), null, "头部不是合法 JSON");
  assert.equal(decodeBinaryFrame(Buffer.concat([Buffer.from([1, 0]), randomBytes(20)])), null, "载荷太短（不足 nonce+tag）");
  assert.equal(supportsBinaryFrames(["e2e-bin"]), true);
  assert.equal(supportsBinaryFrames(undefined), false, "没声明能力 → 走老路");
  assert.equal(supportsBinaryFrames(["other"]), false);
  console.log("ok 2 - 畸形帧全部返回 null（不崩、不当帧解）；能力协商判定正确");
}

// ---- 3. 中继二进制路由（与 JSON 版同规矩）------------------------------------
{
  const relay = spawn(process.execPath, [join(ROOT, "mobile", "relay", "index.mjs")], {
    env: { ...process.env, RELAY_PORT: "0", RELAY_PING_MS: "1500", RELAY_DEAD_MS: "4000" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let buffer = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay did not become ready in 5s")), 5_000);
    relay.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/ready ws:\/\/[^:]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  }).catch((error) => {
    relay.kill();
    throw error;
  });

  const connect = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const frames = [];
      ws.on("open", () => resolve({ ws, frames }));
      ws.on("message", (data, isBinary) => frames.push(isBinary ? { binary: data.length } : JSON.parse(data.toString())));
      ws.on("error", reject);
    });

  try {
    // 主机侧：注册后发一条指向「不存在的设备」的二进制帧 → 必须 DEVICE_OFFLINE（不能静默丢）
    const host = await connect();
    host.ws.send(JSON.stringify({ type: "host.register", hostId: "host-bin-test", bootId: "b1" }));
    await sleep(200);
    const frame = encryptFrameRaw(randomBytes(32), "{}");
    host.ws.send(encodeBinaryFrame({ to: "device-missing" }, frame), { binary: true });
    await sleep(300);
    assert.ok(
      host.frames.some((f) => f?.type === "relay.error" && f.code === "DEVICE_OFFLINE"),
      `主机→设备的二进制帧在设备不在线时要报 DEVICE_OFFLINE（实际 ${JSON.stringify(host.frames)}）`,
    );

    // 设备侧：先注册一张真票，让设备进入 pending，然后发二进制帧 → 必须 NOT_AUTHENTICATED
    host.ws.send(JSON.stringify({ type: "ticket.register", ticket: "t-bin", expiresAt: Date.now() + 60_000 }));
    await sleep(150);
    const device = await connect();
    device.ws.send(JSON.stringify({ type: "pair.request", ticket: "t-bin", deviceId: "device-bin-test", name: "test" }));
    await sleep(200);
    device.ws.send(encodeBinaryFrame({}, frame), { binary: true });
    await sleep(300);
    assert.ok(
      device.frames.some((f) => f?.type === "relay.error" && f.code === "NOT_AUTHENTICATED"),
      `未批准的设备发二进制帧要被拒（实际 ${JSON.stringify(device.frames)}）`,
    );

    host.ws.close();
    device.ws.close();
    console.log("ok 3 - 中继二进制路由：设备不在线 → DEVICE_OFFLINE；未批准 → 被拒（与 JSON 版同规矩）");
  } finally {
    relay.kill();
    await sleep(80);
  }
}

console.log("e2e-binary tests passed");
