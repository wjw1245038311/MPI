/**
 * 中继**主机准入**（P1，见 docs/RELAY-SHARING.md §3.1）：
 *
 * 把中继分享给朋友时，不能让任何人都能连上来白用。规则：
 *   · 未配 `RELAY_HOST_TOKENS` / `RELAY_TOKEN_FILE` → **开放模式**（自用、局域网内嵌、既有测试）；
 *   · 配了允许列表 → `host.register` 必须带命中列表的 `token`，否则 4003 + HOST_UNAUTHORIZED，
 *     且**不能**建立 host 路由（否则设备照样能找到它）。
 *
 * 同时钉死「token 不进配对票」这条不变量：配对票只放 hostId/公钥/地址，别的一律不出现。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_ENTRY = join(ROOT, "mobile", "relay", "index.mjs");
const CLOSE_HOST_UNAUTHORIZED = 4003;

/** 起一个中继，返回 { port, stop() }。env 可覆盖（用于开/关准入）。 */
function startRelay(env = {}) {
  const child = spawn(process.execPath, [RELAY_ENTRY], {
    env: { ...process.env, RELAY_PORT: "0", RELAY_PING_MS: "1500", RELAY_DEAD_MS: "4000", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let buffer = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay did not become ready in 5s")), 5_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/ready ws:\/\/[^:]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`relay exited early (code ${code})`)));
  });
  return {
    ready,
    stop: async () => {
      child.kill();
      await sleep(80);
    },
  };
}

/** 发一帧 host.register，收集回帧与关闭码。 */
function register(port, frame, waitMs = 700) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames = [];
    let closed = null;
    const done = () => {
      try { ws.close(); } catch { /* already closed */ }
      resolve({ frames, closed });
    };
    ws.on("open", () => ws.send(JSON.stringify(frame)));
    ws.on("message", (data) => {
      try { frames.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    ws.on("close", (code) => { closed = code; done(); });
    ws.on("error", () => { /* close follows */ });
    setTimeout(done, waitMs);
  });
}

const hostRegister = (hostId, extra = {}) => ({ type: "host.register", hostId, bootId: "boot-1", ...extra });

// ---- 1. 开放模式（没配任何 token）：行为与从前完全一致 ----
{
  const relay = startRelay();
  const port = await relay.ready;
  try {
    const res = await register(port, hostRegister("host-open-1"));
    assert.ok(res.frames.some((f) => f.type === "relay.ok" && f.role === "host"), "开放模式应直接注册成功");
    assert.notEqual(res.closed, CLOSE_HOST_UNAUTHORIZED, "开放模式不该因凭证被踢");
    console.log("ok 1 - 未配 token = 开放模式（自用/局域网内嵌/既有测试不受影响）");
  } finally {
    await relay.stop();
  }
}

// ---- 2. 配了允许列表：无 token / 错 token 一律拒，且不建立路由 ----
{
  const relay = startRelay({ RELAY_HOST_TOKENS: "friend-a,friend-b" });
  const port = await relay.ready;
  try {
    const missing = await register(port, hostRegister("host-no-token"));
    assert.ok(
      missing.frames.some((f) => f.type === "relay.error" && f.code === "HOST_UNAUTHORIZED"),
      `缺 token 应先回 HOST_UNAUTHORIZED（实际 ${JSON.stringify(missing.frames)}）`,
    );
    assert.equal(missing.closed, CLOSE_HOST_UNAUTHORIZED, "缺 token 应被断开（4003）");
    assert.ok(!missing.frames.some((f) => f.type === "relay.ok"), "缺 token 不能注册成功");

    const wrong = await register(port, hostRegister("host-wrong-token", { token: "friend-c" }));
    assert.ok(wrong.frames.some((f) => f.type === "relay.error" && f.code === "HOST_UNAUTHORIZED"), "错 token 应被拒");
    assert.equal(wrong.closed, CLOSE_HOST_UNAUTHORIZED, "错 token 应被断开（4003）");

    // 正确 token → 注册成功（否则朋友自己也连不上）
    const right = await register(port, hostRegister("host-ok", { token: "friend-b" }));
    assert.ok(right.frames.some((f) => f.type === "relay.ok" && f.role === "host"), "正确 token 应注册成功");
    console.log("ok 2 - 配了允许列表：缺/错 token 拒（4003）且不注册；正确 token 放行");
  } finally {
    await relay.stop();
  }
}

// ---- 3. token 文件 + 热重载（吊销不用重启中继）----
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-relay-tokens-"));
  const tokenFile = join(dir, "host-tokens.txt");
  writeFileSync(tokenFile, "# 允许的主机\nfriend-file\n");
  const relay = startRelay({ RELAY_TOKEN_FILE: tokenFile });
  const port = await relay.ready;
  try {
    const ok = await register(port, hostRegister("host-file", { token: "friend-file" }));
    assert.ok(ok.frames.some((f) => f.type === "relay.ok"), "token 文件里的凭证应放行");

    // 吊销：改文件 → 等热重载（5s 周期；测试里等 6s 稍久但只跑一次）
    writeFileSync(tokenFile, "# 已吊销\nsomeone-else\n");
    await sleep(6_000);
    const revoked = await register(port, hostRegister("host-file-2", { token: "friend-file" }));
    assert.ok(
      revoked.frames.some((f) => f.type === "relay.error" && f.code === "HOST_UNAUTHORIZED"),
      "从 token 文件里删掉的凭证应在热重载后失效（不用重启中继）",
    );
    console.log("ok 3 - token 文件支持热重载：改文件即可发放/吊销");
  } finally {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 4. 不变量：配对票里不出现中继 token ----
{
  const { readFileSync } = await import("node:fs");
  const ipc = readFileSync(join(ROOT, "src", "main", "ipc.ts"), "utf8");
  // 配对票（pairingScanUrl 的载荷 / 配对票构造处）不得引用 remoteRelayToken
  const ticketSections = ipc.split(/\n/).filter((line) => /pairingScanUrl|pairing\.ticket|ticketPayload|qp\.set\(/.test(line));
  assert.ok(
    ticketSections.every((line) => !line.includes("remoteRelayToken") && !line.includes("relayToken")),
    "配对票的构造里绝不能出现中继 token（否则设备也拿到主机凭证）",
  );
  console.log("ok 4 - 配对票不含中继 token（只放 hostId/公钥/地址）");
}

console.log("relay-host-auth tests passed");
