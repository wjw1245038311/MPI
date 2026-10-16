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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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


// ---- 5. 授权码的设备额度：一个码最多 N 台（同一 hostId 重连不占新名额）+ /authz/check ----
{
  const tokenFile = join(mkdtempSync(join(tmpdir(), "mpi-relay-authz-")), "codes.txt");
  const devicesFile = `${tokenFile}.devices.json`;
  writeFileSync(tokenFile, "share-code");
  const relay = startRelay({
    RELAY_TOKEN_FILE: tokenFile,
    RELAY_AUTH_FILE: devicesFile,
    RELAY_AUTH_MAX_DEVICES: "3",
  });
  try {
    const port = await relay.ready;
    const good = (hostId) => register(port, hostRegister(hostId, { token: "share-code" }));

    for (const hostId of ["dev-a", "dev-b", "dev-c"]) {
      const res = await good(hostId);
      assert.ok(res.frames.some((f) => f.type === "relay.ok"), `${hostId} 在额度内应注册成功`);
    }
    // 第 4 台：拒绝 + 专用错误码
    const denied = await good("dev-d");
    assert.ok(
      denied.frames.some((f) => f.type === "relay.error" && f.code === "HOST_DEVICE_LIMIT"),
      "第 4 台设备必须被 HOST_DEVICE_LIMIT 拒绝（一个码最多 3 台）",
    );
    assert.ok(!denied.frames.some((f) => f.type === "relay.ok"), "被拒的设备不能建立 host 路由");
    // 同一台已登记的设备重连：不算新设备
    const reconnect = await good("dev-a");
    assert.ok(reconnect.frames.some((f) => f.type === "relay.ok"), "同一 hostId 重连必须放行（否则重连即掉线）");

    // /authz/check：服务器通 + 码对 + 用量（不回设备 id）
    const check = await fetch(`http://127.0.0.1:${port}/authz/check`, { headers: { authorization: "Bearer share-code" } });
    assert.equal(check.status, 200);
    const body = await check.json();
    assert.equal(body.ok, true);
    assert.equal(body.devices, 3, "用量应如实反映 3 台");
    assert.equal(body.maxDevices, 3);
    assert.equal(body.enforcing, true);
    assert.ok(!JSON.stringify(body).includes("dev-a"), "自检结果不得回显设备 id");

    const bad = await fetch(`http://127.0.0.1:${port}/authz/check`, { headers: { authorization: "Bearer nope" } });
    assert.equal(bad.status, 401, "错码要 401（客户端「验证连通性」据此报错）");

    // 「立即激活」/「解除绑定」端点：先腾一个名额，再登记一台并记下机器名
    const unbind = await fetch(`http://127.0.0.1:${port}/authz/deactivate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer share-code" },
      body: JSON.stringify({ hostId: "dev-b" }),
    });
    assert.equal(unbind.status, 200, "解除绑定要 200");
    const afterUnbind = await unbind.json();
    assert.equal(afterUnbind.removed, true, "解除绑定应真的删掉那台");
    assert.equal(afterUnbind.devices, 2, "解除后用量减一");

    const activate = await fetch(`http://127.0.0.1:${port}/authz/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer share-code" },
      body: JSON.stringify({ hostId: "dev-e", name: "WJW-PC" }),
    });
    assert.equal(activate.status, 200, "腾出名额后激活应成功");
    const activated = await activate.json();
    assert.equal(activated.devices, 3, "激活后用量加一");
    assert.ok(
      activated.deviceList?.some((d) => d.hostId === "dev-e" && d.name === "WJW-PC"),
      "设备表要记住机器名（服务器侧能看出是哪台）",
    );

    const overflow = await fetch(`http://127.0.0.1:${port}/authz/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer share-code" },
      body: JSON.stringify({ hostId: "dev-f", name: "another" }),
    });
    assert.equal(overflow.status, 409, "第 4 台激活必须 409（额度 3 台）");
    assert.equal((await overflow.json()).error, "HOST_DEVICE_LIMIT");

    const wrongCode = await fetch(`http://127.0.0.1:${port}/authz/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ hostId: "dev-g" }),
    });
    assert.equal(wrongCode.status, 401, "错码激活要 401");

    console.log("ok 5 - 一个码最多 3 台设备（hostId 区分，重连不占名额）+ /authz/check 自检");
  } finally {
    await relay.stop();
    rmSync(dirname(tokenFile), { recursive: true, force: true });
  }
}


// ---- 6. 加固（2026-10-16 用户要求"全做"）：/healthz 收敛 + 按 IP 限速 + 单 IP 连接上限 ----
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-relay-hardening-"));
  const tokenFile = join(dir, "codes.txt");
  writeFileSync(tokenFile, "share-code");
  const relay = startRelay({
    RELAY_TOKEN_FILE: tokenFile,
    RELAY_AUTH_FAIL_LIMIT: "3",
    RELAY_AUTH_BLOCK_MS: "2000",
  });
  try {
    const port = await relay.ready;
    const base = `http://127.0.0.1:${port}`;

    // ① /healthz 收敛：配了准入时，无码只回 {ok:true}（不再免费告诉扫描者有多少主机/设备）
    const bare = await (await fetch(`${base}/healthz`)).json();
    assert.deepEqual(bare, { ok: true }, "配了准入时 /healthz 不得回计数");
    const privileged = await (
      await fetch(`${base}/healthz`, { headers: { authorization: "Bearer share-code" } })
    ).json();
    assert.equal(typeof privileged.hosts, "number", "带有效激活码才给计数");

    // ② 按 IP 限速：连续错码达到阈值 → 封禁期内**即便码是对的**也拒（挡暴力猜）
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/authz/check`, { headers: { authorization: "Bearer wrong" } });
    }
    const blocked = await fetch(`${base}/authz/check`, { headers: { authorization: "Bearer share-code" } });
    assert.equal(blocked.status, 429, "封禁期内应 429（先挡猜码，再谈对不对）");
    const blockedHealth = await fetch(`${base}/healthz`, { headers: { authorization: "Bearer share-code" } });
    assert.equal(blockedHealth.status, 429, "被封的 IP 连 /healthz 也拒");
    await sleep(2_200);
    const recovered = await fetch(`${base}/authz/check`, { headers: { authorization: "Bearer share-code" } });
    assert.equal(recovered.status, 200, "封禁到期后自动恢复（不用重启中继）");
    console.log("ok 6 - 加固：/healthz 收敛 + 按 IP 限速（含自动解封）");
  } finally {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 7. 单 IP 并发 WS 连接上限 ----
{
  const relay = startRelay({ RELAY_MAX_WS_PER_IP: "2" });
  try {
    const port = await relay.ready;
    const openOne = () =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on("open", () => resolve(ws));
        ws.on("error", (e) => resolve({ error: e.message }));
      });
    const a = await openOne();
    const b = await openOne();
    assert.ok(a instanceof WebSocket && b instanceof WebSocket, "前两条连接应建立");
    const third = await openOne();
    assert.ok(third?.error, "第 3 条连接应被拒（上限 2）");
    a.close();
    b.close();
    console.log("ok 7 - 单 IP 并发 WS 连接上限（超限直接 429）");
  } finally {
    await relay.stop();
  }
}

console.log("relay-host-auth tests passed");
