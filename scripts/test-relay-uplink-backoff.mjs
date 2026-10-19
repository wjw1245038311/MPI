/**
 * 主机上行 **准入失败要退避**（2026-10-19 真实事故回归）。
 *
 * 事故：一台没配中继 token 的主机在 `host.register` 被拒后**每 1~2 秒重试一次**，一整天刷了
 * 320 次拒绝，并每 10 次失败触发一次中继的「该 IP 封 60s」——同一 NAT 后面的设备都被连坐。
 * 根因：`ws.on("open")` 里把 retryCount 清零，而「TLS 连上了、首帧被拒」也是 open → close 的
 * 短循环 → 指数退避永远起不来。
 *
 * 现在的约定（钉在本测试里）：
 *   · `host.register` 收到 `HOST_UNAUTHORIZED` / `HOST_DEVICE_LIMIT` → 重试下限 **5 分钟**；
 *   · 收到 `RATE_LIMITED`（中继要求退避）→ 重试下限 **60 秒**；
 *   · 但都**不停死**：凭证改对/名额腾出后，下一轮自动接上；收到 `relay.ok` 才清零。
 *
 * 断言方式：用一个假中继统计「N 秒内建了几条连接」——旧行为 6 秒内会有 4~6 条，新行为只有 1 条。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { register } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register(new URL("./electron-stub-loader.mjs", import.meta.url));

/**
 * 假中继：接受连接 → 收首帧 → 回一条 `relay.error{code}` → 断开（模拟中继准入拒绝）。
 * 返回 { url, attempts(), close() }；attempts 统计建立过几条 socket。
 */
async function startRejectingRelay(code) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let attempts = 0;
  wss.on("connection", (ws) => {
    attempts += 1;
    ws.on("message", () => {
      try {
        ws.send(JSON.stringify({ type: "relay.error", code }));
      } catch { /* 已经关了 */ }
      try {
        ws.close(4003, code);
      } catch { /* 已经关了 */ }
    });
  });
  await new Promise((resolve) => wss.once("listening", resolve));
  return {
    url: `ws://127.0.0.1:${wss.address().port}/ws`,
    attempts: () => attempts,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

async function runCase(code, waitMs) {
  const userData = mkdtempSync(join(tmpdir(), "mpi-uplink-backoff-"));
  const relay = await startRejectingRelay(code);
  process.env.MPI_TEST_USER_DATA = userData;
  const { RelayUplink } = await import("../src/main/remote/relay-uplink.ts");
  const uplink = new RelayUplink({
    relayUrl: relay.url,
    hostId: "test-host",
    userDataDir: userData,
    x25519PrivB64u: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    x25519PubB64u: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    getHost: () => null,
  });
  try {
    uplink.start();
    await sleep(waitMs);
    const attempts = relay.attempts();
    const status = uplink.getStatus();
    assert.equal(attempts, 1, `${code}: ${waitMs}ms 内只应尝试 1 次（旧行为每 1~2s 一次会打满整个窗口），实际 ${attempts}`);
    assert.equal(status.state, "error", `${code}: 状态应为 error，实际 ${status.state}`);
    assert.equal(status.lastError, code, `${code}: lastError 应保留中继错误码，实际 ${status.lastError}`);
    console.log(`ok - ${code}: 退避生效（${waitMs}ms 内仅 1 次尝试，lastError=${status.lastError}）`);
  } finally {
    uplink.stop();
    await relay.close();
    rmSync(userData, { recursive: true, force: true });
  }
}

// 永久性准入错误 → 5 分钟下限（6s 窗口内必须只有 1 次）
await runCase("HOST_UNAUTHORIZED", 6_000);
// 中继要求退避 → 60s 下限（5s 窗口内同样只有 1 次）
await runCase("RATE_LIMITED", 5_000);

console.log("relay-uplink-backoff tests passed");
