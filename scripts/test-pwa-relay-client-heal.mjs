/**
 * PWA 客户端两条「自愈」回归（2026-10-19 真机取证后加）：
 *
 *  ① **被撤销就停**：主机 `device.revoke` → 中继发 `revoked` + close 4002，令牌两边都没了。
 *     以前客户端只特判 `replaced`，于是每轮重连都被 4001 拒掉 → 界面永远「重新连接中…」
 *     （昨天 ECS 日志里 29 条 `hello rejected (auth failed)` 就是这个形状）。
 *  ② **死 socket 自愈**：冻结/休眠后 socket 可能已断而**不派发 close**（无头 Chrome 实测：
 *     冻结 120s 后 150s 内没有新连接）。看门狗每 5s 检查一次，前台+该连+没 socket+没在退避
 *     → 直接重开。
 *
 * 反向保护：4001（AUTH_FAILED）**仍然**要保持重试——中继刚重启、主机还在补报令牌的那段
 * 窗口里它是暂时的（这条钉住，避免把「被撤销」的修复扩大成「一遇 4001 就躺平」）。
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer } from "ws";

const { RelayClient } = await import("../mobile/pwa/src/lib/relay-client.ts");

async function startServer(onConnection) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let connections = 0;
  wss.on("connection", (ws) => {
    connections += 1;
    onConnection(ws, connections);
  });
  await new Promise((resolve) => wss.once("listening", resolve));
  return {
    url: `ws://127.0.0.1:${wss.address().port}/ws`,
    count: () => connections,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

// ---- ① revoked 帧 → 停止重连 ----
{
  const server = await startServer((ws) => {
    ws.send(JSON.stringify({ type: "revoked" }));
    ws.close(4002, "REVOKED");
  });
  const client = new RelayClient({ url: server.url });
  try {
    client.connect();
    await sleep(2_500);
    assert.equal(server.count(), 1, `收到 revoked 后不该再重连（实际建了 ${server.count()} 条）`);
    assert.equal(client.getState(), "closed", `状态应为 closed，实际 ${client.getState()}`);
    assert.equal(client.getLastError(), "REVOKED", `lastError 应为 REVOKED，实际 ${client.getLastError()}`);
    console.log("ok 1 - revoked 帧 → 停止重连，lastError=REVOKED");
  } finally {
    client.close();
    await server.close();
  }
}

// ---- ①b 只有 4002 关闭码（revoked 帧没到）→ 也要停 ----
{
  const server = await startServer((ws) => ws.close(4002, "REVOKED"));
  const client = new RelayClient({ url: server.url });
  try {
    client.connect();
    await sleep(2_500);
    assert.equal(server.count(), 1, `4002 也应停止重连（实际建了 ${server.count()} 条）`);
    assert.equal(client.getLastError(), "REVOKED");
    console.log("ok 2 - close 4002（无 revoked 帧）→ 同样停止重连");
  } finally {
    client.close();
    await server.close();
  }
}

// ---- ② 死 socket（无 close 事件）→ 看门狗重连 ----
{
  class FakeWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = FakeWS.CONNECTING;
      FakeWS.instances.push(this);
      setTimeout(() => {
        this.readyState = FakeWS.OPEN;
        this.onopen?.();
      }, 0);
    }
    send() {}
    close() {
      this.readyState = FakeWS.CLOSED;
    }
  }
  const nativeWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  const client = new RelayClient({ url: "ws://fake.local/ws" });
  try {
    client.connect();
    await sleep(200);
    assert.equal(FakeWS.instances.length, 1, "应已建 1 条");
    // 模拟「冻结后 socket 已死、但 close 事件没来」
    FakeWS.instances[0].readyState = FakeWS.CLOSED;
    await sleep(6_500); // 看门狗周期 5s
    assert.ok(FakeWS.instances.length >= 2, `看门狗应重开一条（实际 ${FakeWS.instances.length} 条）`);
    console.log(`ok 3 - 死 socket（无 close 事件）→ 看门狗重连（共 ${FakeWS.instances.length} 条）`);
  } finally {
    client.close();
    globalThis.WebSocket = nativeWS;
  }
}

// ---- ③ 反向保护：4001 AUTH_FAILED 仍要继续重试 ----
{
  const server = await startServer((ws) => ws.close(4001, "AUTH_FAILED"));
  const client = new RelayClient({ url: server.url });
  try {
    client.connect();
    await sleep(3_500);
    assert.ok(server.count() >= 2, `4001 是暂时性的，必须继续重试（实际只有 ${server.count()} 条）`);
    console.log(`ok 4 - 4001 AUTH_FAILED 仍按退避重试（${server.count()} 条）`);
  } finally {
    client.close();
    await server.close();
  }
}

console.log("relay client healing tests passed");
