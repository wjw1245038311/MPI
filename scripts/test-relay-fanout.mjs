/**
 * 多中继聚合器（阶段 ②「主机双中继上行」）的路由规则。
 *
 * 这里钉的是**最容易悄悄错**的四件事：
 *   ① 单通道必须与直接用 RelayUplink 完全等价（否则多路改造会回归现有安装）；
 *   ② `ticket.register` 这类控制帧必须**广播**——只注册一条的话，手机扫到另一条票就是「主机离线」；
 *   ③ 推送**只能投一条**——两条都投 = 手机收两条通知（用户能直接看见的 bug）；
 *   ④ 读类（deviceToken / E2E 会话密钥）要**遍历查找**——会话只存在于实际处理配对的那条中继上。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { RelayFanout } = await import("../src/main/remote/relay-fanout.ts");

/** 假上行：记录所有调用，并可控「设备是否在线 / 是否有订阅 / 是否持有 token 与 E2E 密钥」。 */
function fakeUplink(key, opts = {}) {
  const calls = [];
  const connected = new Set(opts.connected ?? []);
  const subs = new Set(opts.subs ?? []);
  const tokens = opts.tokens ?? {};
  const devices = opts.devices ?? [];
  const e2eMap = opts.e2eMap ?? {};
  return {
    calls,
    connected,
    subs,
    start: () => calls.push({ op: "start" }),
    stop: () => calls.push({ op: "stop" }),
    relayUrl: () => `ws://${key}/ws`,
    getStatus: () => ({ state: "connected", relayUrl: `ws://${key}/ws`, lastError: null }),
    instanceKey: () => key,
    sendToDevice: (deviceId, frame) => calls.push({ op: "sendToDevice", deviceId, frame }),
    sendControl: (frame) => {
      calls.push({ op: "sendControl", frame });
      return true;
    },
    deviceToken: (deviceId) => tokens[deviceId] ?? null,
    notifyRevoked: (deviceId) => calls.push({ op: "notifyRevoked", deviceId }),
    activateE2E: (deviceId) => calls.push({ op: "activateE2E", deviceId }),
    deactivateE2E: (deviceId) => calls.push({ op: "deactivateE2E", deviceId }),
    e2eSessionKeyFor: (deviceId) => e2eMap[deviceId] ?? null,
    storePushSubscription: (deviceId, sub) => calls.push({ op: "storePushSubscription", deviceId, sub }),
    sendPush: (deviceId, push) => {
      calls.push({ op: "sendPush", deviceId, push });
      return true;
    },
    getKnownDeviceIds: () => [...devices],
    isDeviceConnected: (deviceId) => connected.has(deviceId),
    hasPushSubscription: (deviceId) => subs.has(deviceId),
  };
}

const opsOf = (u, op) => u.calls.filter((c) => c.op === op);

// ---- ① 单通道：与直接用 RelayUplink 等价 ----
test("单通道退化为直通（多路改造不得回归现有安装）", () => {
  const only = fakeUplink("primary", { connected: ["dev-1"], devices: ["dev-1"] });
  const fan = new RelayFanout({ uplinks: [only] });

  fan.sendToDevice("dev-1", "frame-1");
  fan.sendToDevice("dev-1", "frame-2");
  assert.equal(opsOf(only, "sendToDevice").length, 2, "全部帧都走同一条");

  assert.equal(fan.sendControl({ type: "ticket.register", ticket: "t1" }), true);
  assert.equal(fan.sendControl({ type: "push.request", deviceId: "dev-1" }), true);
  assert.equal(opsOf(only, "sendControl").length, 2, "单通道时控制帧不丢");

  assert.equal(fan.relayUrl(), "ws://primary/ws", "主中继地址沿用第一条");
  assert.deepEqual(fan.getStatus().state, "connected");
  assert.deepEqual(fan.getKnownDeviceIds(), ["dev-1"]);
});

// ---- ② 控制帧：ticket.register 必须广播 ----
test("ticket.register 广播到所有中继（手机扫哪条票都得能连上）", () => {
  const a = fakeUplink("ecs");
  const b = fakeUplink("cf");
  const fan = new RelayFanout({ uplinks: [a, b] });

  fan.sendControl({ type: "ticket.register", ticket: "t1", expiresAt: 1 });

  assert.equal(opsOf(a, "sendControl").length, 1, "主中继要注册");
  assert.equal(opsOf(b, "sendControl").length, 1, "备用中继也要注册");
});

test("带 deviceId 的控制帧只发一条（不重复通知）", () => {
  const a = fakeUplink("ecs");
  const b = fakeUplink("cf", { connected: ["dev-1"] });
  const fan = new RelayFanout({ uplinks: [a, b] });

  fan.sendControl({ type: "push.request", deviceId: "dev-1", kind: "approval" });

  assert.equal(opsOf(a, "sendControl").length, 0, "设备不在主中继上，不投它");
  assert.equal(opsOf(b, "sendControl").length, 1, "只投设备所在的那条");
});

// ---- ③ 推送：只投一条 ----
test("推送按在线归属只投一条；两条中继都不得重复投递", () => {
  const a = fakeUplink("ecs", { connected: ["dev-1"], subs: ["dev-1"] });
  const b = fakeUplink("cf", { connected: ["dev-1"], subs: ["dev-1"] });
  const fan = new RelayFanout({ uplinks: [a, b] });

  assert.equal(fan.sendPush("dev-1", { kind: "approval", title: "x" }), true);
  const total = opsOf(a, "sendPush").length + opsOf(b, "sendPush").length;
  assert.equal(total, 1, "重复投递 = 手机收到两条通知");
});

test("设备离线时回退到「持有推送订阅」的那条", () => {
  const a = fakeUplink("ecs"); // 没有订阅
  const b = fakeUplink("cf", { subs: ["dev-1"] });
  const fan = new RelayFanout({ uplinks: [a, b] });

  fan.sendPush("dev-1", { kind: "approval", title: "x" });

  assert.equal(opsOf(a, "sendPush").length, 0, "没有订阅的中继投不了（订阅与 VAPID 绑定）");
  assert.equal(opsOf(b, "sendPush").length, 1);
});

test("既不在线也无订阅 → 只投主中继（确定性，不做无意义广播）", () => {
  const a = fakeUplink("ecs");
  const b = fakeUplink("cf");
  const fan = new RelayFanout({ uplinks: [a, b] });

  fan.sendPush("dev-unknown", { kind: "approval", title: "x" });

  assert.equal(opsOf(a, "sendPush").length, 1);
  assert.equal(opsOf(b, "sendPush").length, 0);
});

// ---- ④ 帧与读操作 ----
test("帧按在线归属路由；归属未知时广播（由中继侧丢弃多余份）", () => {
  const a = fakeUplink("ecs");
  const b = fakeUplink("cf", { connected: ["dev-1"] });
  const fan = new RelayFanout({ uplinks: [a, b] });

  fan.sendToDevice("dev-1", "f1");
  assert.equal(opsOf(a, "sendToDevice").length, 0);
  assert.equal(opsOf(b, "sendToDevice").length, 1);

  fan.sendToDevice("dev-2", "f2");
  assert.equal(opsOf(a, "sendToDevice").length, 1, "未知归属 → 广播");
  assert.equal(opsOf(b, "sendToDevice").length, 2);
});

test("deviceToken / E2E 会话密钥遍历查找（会话只在处理配对的那条上）", () => {
  const a = fakeUplink("ecs");
  const b = fakeUplink("cf", { tokens: { "dev-1": "tok-1" }, e2eMap: { "dev-1": Buffer.from("k") } });
  const fan = new RelayFanout({ uplinks: [a, b] });

  assert.equal(fan.deviceToken("dev-1"), "tok-1", "token 只在备用中继上，也要找得到");
  assert.equal(fan.e2eSessionKeyFor("dev-1")?.toString(), "k");
  assert.equal(fan.deviceToken("dev-nope"), null);
  assert.equal(fan.e2eSessionKeyFor("dev-nope"), null);
});

test("getKnownDeviceIds 合并去重；start/stop 覆盖全部通道；statuses 暴露两条", () => {
  const a = fakeUplink("ecs", { devices: ["dev-1", "dev-2"] });
  const b = fakeUplink("cf", { devices: ["dev-2", "dev-3"] });
  const fan = new RelayFanout({ uplinks: [a, b] });

  assert.deepEqual(fan.getKnownDeviceIds().sort(), ["dev-1", "dev-2", "dev-3"]);

  fan.start();
  fan.stop();
  assert.equal(opsOf(a, "start").length, 1);
  assert.equal(opsOf(b, "start").length, 1);
  assert.equal(opsOf(a, "stop").length, 1);
  assert.equal(opsOf(b, "stop").length, 1);

  assert.deepEqual(
    fan.statuses().map((s) => s.key),
    ["ecs", "cf"],
    "面板要能分别显示两条通道状态",
  );
});

test("storePushSubscription 存到设备当前所在通道（订阅与中继 VAPID 绑定）", () => {
  const a = fakeUplink("ecs");
  const b = fakeUplink("cf", { connected: ["dev-1"] });
  const fan = new RelayFanout({ uplinks: [a, b] });

  fan.storePushSubscription("dev-1", { endpoint: "https://push/x", keys: { p256dh: "p", auth: "a" } });

  assert.equal(opsOf(a, "storePushSubscription").length, 0, "不在线的通道不该拿到该设备的订阅");
  assert.equal(opsOf(b, "storePushSubscription").length, 1);
});

// ---- ⑤ 接线守卫（源码级）：两条上行都交给 fanout，路由不再绕过它 ----
test("ipc 接线：主+备都进 fanout，推送/附件密钥走聚合器", async () => {
  const { readFileSync } = await import("node:fs");
  const ipc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
  const cfg = readFileSync(new URL("../src/main/config.ts", import.meta.url), "utf8");

  assert.match(ipc, /relayFanout = new RelayFanout\(/, "要有聚合器实例");
  assert.match(ipc, /remoteHost\.setRelay\(relayFanout\)/, "RemoteHost 拿到的必须是聚合器");
  assert.match(ipc, /instanceKey: channel\.id/, "持久化实例键要来自通道 id（与主上行隔离，否则互相覆盖 deviceToken）");
  assert.match(ipc, /planUplinks\(wanted, ctx\)/, "主机上行地址与同址归并都交给通道模型（planUplinks）");
  assert.match(ipc, /remoteRelayFallbackEnabled/, "备用通道要受配置开关控制");

  for (const pat of [
    /activeRelayUplink\?\.e2eSessionKeyFor/,
    /activeRelayUplink\?\.storePushSubscription/,
    /activeRelayUplink\?\.sendPush/,
    /activeRelayUplink\?\.getKnownDeviceIds/,
  ]) {
    assert.ok(!pat.test(ipc), `路由不得再绕过 fanout：${pat}`);
  }

  assert.match(cfg, /remoteRelayFallbackEnabled: boolean/, "配置项：备用通道开关");
  assert.match(cfg, /mobileRelayFallbackUrl: string/, "配置项：手机侧备用地址");
});

console.log("relay-fanout tests passed");
