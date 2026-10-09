/**
 * 通道模型（S2，实施计划-C档多通道.md §三）：列表 + 模式 + 迁移 + 推导 + 校验。
 *
 * 这里钉五件最容易悄悄错的事：
 *   ① **旧字段合成的通道必须与改造前行为等价**（否则老用户一升级就掉线）；
 *   ② **能推导的就不让用户填**（本机通道上行 = 127.0.0.1:port；局域网 = 内网 IP）；
 *   ③ 局域网通道**置顶**（设备端按序选路时优先用最快的）；
 *   ④ 手动模式只挂一条（与改造前等价）；自动模式挂全部启用通道；
 *   ⑤ **同主机上行地址只允许一条启用**——同 hostId 在同一中继注册两次会互相顶掉。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { fromLegacy, lanChannel, effectiveChannels, hostUrlFor, uplinkChannels, ticketAddresses, validateChannels, pickRelayFeedUrl, flipScheme } =
  await import("../src/main/remote/relay-channels.ts");

const ctx = (over = {}) => ({ localRelayPort: 9001, lanPhoneUrl: null, lanAddress: null, ...over });

// ---- ① 旧字段迁移 ----
test("旧字段合成通道：主中继保留显式上行与 token，本机通道留空待推导", () => {
  const channels = fromLegacy({
    remoteRelayUrl: "wss://aliyun-ecs.tail38d5a.ts.net:9443/ws",
    mobileRelayUrl: "ws://47.97.28.110:10445/ws",
    remoteRelayToken: "tok-1",
    remoteRelayFallbackEnabled: true,
    mobileRelayFallbackUrl: "wss://relay.whomidas.cn/ws",
  });
  assert.equal(channels.length, 2);
  assert.deepEqual(
    { id: channels[0].id, phone: channels[0].phoneUrl, host: channels[0].hostUrl, token: channels[0].token, kind: channels[0].kind },
    {
      id: "primary",
      phone: "ws://47.97.28.110:10445/ws",
      host: "wss://aliyun-ecs.tail38d5a.ts.net:9443/ws",
      token: "tok-1",
      kind: "remote",
    },
    "主通道要保留主机侧显式地址（可能是 tailnet wss，与手机地址不同）",
  );
  assert.deepEqual(
    { id: channels[1].id, phone: channels[1].phoneUrl, host: channels[1].hostUrl, kind: channels[1].kind },
    { id: "local", phone: "wss://relay.whomidas.cn/ws", host: undefined, kind: "local" },
    "本机通道不填主机上行（由 kind=local 推导）",
  );

  // 关掉备用 → 只剩主通道（与改造前 remoteRelayFallbackEnabled=false 等价）
  assert.equal(fromLegacy({ remoteRelayUrl: "ws://a/ws", remoteRelayFallbackEnabled: false }).length, 1);
  // 手机地址留空 → 回落到主机上行地址（旧行为）
  assert.equal(fromLegacy({ remoteRelayUrl: "wss://a/ws" })[0].phoneUrl, "wss://a/ws");
  // 什么都没有 → 空列表
  assert.deepEqual(fromLegacy({}), []);
});

// ---- ② 地址推导 ----
test("主机上行推导：显式优先；本机→回环；局域网→内网 IP；其它→手机地址原样", () => {
  assert.equal(hostUrlFor({ id: "x", label: "x", phoneUrl: "wss://cf/ws", hostUrl: "ws://explicit/ws", enabled: true, kind: "local" }, ctx()), "ws://explicit/ws");
  assert.equal(hostUrlFor({ id: "local", label: "本机", phoneUrl: "wss://relay.whomidas.cn/ws", enabled: true, kind: "local" }, ctx()), "ws://127.0.0.1:9001/ws");
  assert.equal(hostUrlFor({ id: "lan", label: "局域网", phoneUrl: "ws://192.168.1.9:9001/ws", enabled: true, kind: "lan" }, ctx({ lanAddress: "192.168.1.9" })), "ws://192.168.1.9:9001/ws");
  assert.equal(hostUrlFor({ id: "lan", label: "局域网", phoneUrl: "x", enabled: true, kind: "lan" }, ctx()), "", "拿不到内网 IP → 空（不猜）");
  assert.equal(hostUrlFor({ id: "r", label: "ECS", phoneUrl: "ws://47.97.28.110:10445/ws", enabled: true, kind: "remote" }, ctx()), "ws://47.97.28.110:10445/ws");
  assert.equal(flipScheme("ws://a:1/ws"), "wss://a:1/ws", "ws↔wss 换算（给需要的人用）");
  assert.equal(flipScheme("https://a/"), null, "非 ws(s) 返回 null，不瞎猜");
});

// ---- ③ 局域网通道置顶 ----
test("局域网通道由运行时合成并置顶；没开局域网时不出现", () => {
  const stored = fromLegacy({ remoteRelayUrl: "ws://ecs/ws", remoteRelayFallbackEnabled: true });
  assert.equal(lanChannel(ctx()), null);
  assert.equal(effectiveChannels(stored, {}, ctx()).length, 2, "没局域网 → 原样");

  const withLan = effectiveChannels(stored, {}, ctx({ lanPhoneUrl: "ws://192.168.1.9:9001/ws", lanAddress: "192.168.1.9" }));
  assert.equal(withLan[0].id, "lan", "最快的那条要排最前（设备端按序选路）");
  assert.equal(withLan.length, 3);
  // 配置里有列表时以列表为准（不再用旧字段）
  const explicit = [{ id: "a", label: "A", phoneUrl: "wss://a/ws", enabled: true, kind: "remote" }];
  assert.equal(effectiveChannels(explicit, { remoteRelayUrl: "ws://legacy/ws" }, ctx()).length, 1, "有列表就不用旧字段合成");
});

// ---- ④ 两种模式 ----
test("手动模式只挂选中那条（缺省取首条启用）；自动模式挂全部启用", () => {
  const channels = effectiveChannels(
    fromLegacy({ remoteRelayUrl: "ws://ecs/ws", remoteRelayFallbackEnabled: true }),
    {},
    ctx({ lanPhoneUrl: "ws://192.168.1.9:9001/ws", lanAddress: "192.168.1.9" }),
  ).map((c) => c.id);

  assert.deepEqual(uplinkChannels(channels.length ? [{ id: "a", label: "A", phoneUrl: "u", enabled: true, kind: "remote" }, { id: "b", label: "B", phoneUrl: "v", enabled: true, kind: "local" }] : [], "manual", "b").map((c) => c.id), ["b"], "手动 = 选中那条");
  assert.deepEqual(uplinkChannels([{ id: "a", label: "A", phoneUrl: "u", enabled: true, kind: "remote" }], "manual").map((c) => c.id), ["a"], "没指定 → 首条启用");
  assert.deepEqual(uplinkChannels([{ id: "a", label: "A", phoneUrl: "u", enabled: false, kind: "remote" }], "manual"), [], "没有启用的 → 不挂");

  const auto = uplinkChannels(
    [
      { id: "a", label: "A", phoneUrl: "u", enabled: true, kind: "remote" },
      { id: "b", label: "B", phoneUrl: "v", enabled: false, kind: "remote" },
      { id: "c", label: "C", phoneUrl: "w", enabled: true, kind: "local" },
    ],
    "auto",
  ).map((c) => c.id);
  assert.deepEqual(auto, ["a", "c"], "自动 = 全部启用（跳过关掉的）");
});

// ---- ⑤ 票内地址 ----
test("票内地址：手动一条；自动多条且局域网优先、空地址剔除", () => {
  const channels = [
    { id: "lan", label: "局域网", phoneUrl: "ws://192.168.1.9:9001/ws", enabled: true, kind: "lan" },
    { id: "primary", label: "ECS", phoneUrl: "ws://47.97.28.110:10445/ws", enabled: true, kind: "remote" },
    { id: "local", label: "本机（CF）", phoneUrl: "wss://relay.whomidas.cn/ws", enabled: true, kind: "local" },
    { id: "off", label: "关掉的", phoneUrl: "wss://off/ws", enabled: false, kind: "remote" },
    { id: "empty", label: "没填地址", phoneUrl: "", enabled: true, kind: "local" },
  ];
  assert.deepEqual(ticketAddresses(channels, "manual", "primary"), ["ws://47.97.28.110:10445/ws"], "手动只带选中那条");
  assert.deepEqual(
    ticketAddresses(channels, "auto"),
    ["ws://192.168.1.9:9001/ws", "ws://47.97.28.110:10445/ws", "wss://relay.whomidas.cn/ws"],
    "自动带全部启用；局域网优先；空地址与关掉的不带",
  );
});

// ---- ⑥ 自更新来源 ----
test("自更新来源：取第一条启用的公网通道（跳过 lan / local / 停用的）", () => {
  const channels = [
    { id: "lan", label: "局域网", phoneUrl: "ws://192.168.1.9:9001/ws", enabled: true, kind: "lan" },
    { id: "local", label: "本机（CF）", phoneUrl: "", enabled: true, kind: "local" },
    { id: "off", label: "停用的公网", phoneUrl: "ws://off.example/ws", enabled: false, kind: "remote" },
    { id: "ecs", label: "ECS（主）", phoneUrl: "ws://47.97.28.110:10445/ws", enabled: true, kind: "remote" },
    { id: "ecs-tls", label: "ECS（TLS）", phoneUrl: "wss://47.97.28.110:9443/ws", enabled: true, kind: "remote" },
  ];
  assert.equal(
    pickRelayFeedUrl(channels, ctx()),
    "ws://47.97.28.110:10445/ws",
    "lan/local/停用都不算；取第一条启用的 remote 通道的主机上行",
  );
  assert.equal(pickRelayFeedUrl([], ctx()), "", "一条都没有 → 空串（调用方回退 GitHub）");
});

// ---- ⑦ 校验 ----
test("同主机上行地址：允许重复配置（运行期按 hostUrl 去重，只挂先出现的那条）", () => {
  // 2026-10-09：同一台中继可以暴露多个手机地址（TLS 的 wss + 明文 ws），
  // 主机只需要一条 uplink —— applyRelayUplinkConfig 会跳过重复的 hostUrl。
  const dup = [
    { id: "a", label: "本机（CF）", phoneUrl: "wss://cf/ws", enabled: true, kind: "local" },
    { id: "b", label: "本机（第二份）", phoneUrl: "wss://cf2/ws", enabled: true, kind: "local" },
  ];
  assert.equal(validateChannels(dup, ctx(), "manual").length, 0, "两条推导到同一 hostUrl 也不再报错（运行期去重）");
  assert.equal(
    validateChannels([{ id: "e", label: "空地址", phoneUrl: "", enabled: true, kind: "local" }], ctx(), "auto").length,
    1,
    "自动模式下启用的通道必须有手机地址（否则票里带不上）",
  );
  assert.equal(
    validateChannels([{ id: "e", label: "空地址", phoneUrl: "", enabled: true, kind: "local" }], ctx(), "manual").length,
    0,
    "手动模式允许暂不填（还没配对时常见）",
  );
});

// ---- ⑦ 接线守卫（源码级）----
test("ipc/config 接线：通道列表驱动，旧的「主+备两条」写法已清除", async () => {
  const { readFileSync } = await import("node:fs");
  const ipc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
  const cfg = readFileSync(new URL("../src/main/config.ts", import.meta.url), "utf8");

  for (const pat of [/effectiveChannels\(/, /uplinkChannels\(/, /hostUrlFor\(/, /ticketAddresses\(/]) {
    assert.match(ipc, pat, `主进程要走通道模块：${pat}`);
  }
  assert.ok(!/fallbackRelayUplink/.test(ipc), "旧的「备用上行」专用变量应已移除（改由通道列表 + Map 管理）");
  assert.match(ipc, /instanceKey: channel\.id/, "持久化实例键必须来自通道 id（多通道各自独立 deviceToken）");
  assert.match(cfg, /relayChannels\?: RelayChannel\[\]/, "配置项：通道列表");
  assert.match(cfg, /relayMode: RelayMode/, "配置项：选路模式");
  assert.match(ipc, /mobileRelayUrls: \(\) => phoneTicketAddresses\(\)/, "S3：票里要带整份有序地址列表");
  assert.match(readFileSync(new URL("../src/main/remote/host.ts", import.meta.url), "utf8"), /relayUrls/, "S3：RemoteHost 要把 relayUrls 写进票");
  // S6：主机侧「通道列表下发」——类型系统已保证 backend 实现（RemoteBackend 必实现 getRelayInfo）
  assert.match(readFileSync(new URL("../src/main/remote/protocol.ts", import.meta.url), "utf8"), /"host\.info"/, "S6：协议要有 host.info 请求");
  assert.match(readFileSync(new URL("../src/main/remote/service.ts", import.meta.url), "utf8"), /case "host\.info"/, "S6：service 要分发 host.info");
  assert.match(ipc, /getRelayInfo: \(\) => \(\{/, "S6：主进程要用通道列表回答 host.info");

  // S5：面板要有通道列表 UI，且旧的全局地址字段要拔掉（否则两个真相源）
  const panel = readFileSync(new URL("../src/renderer/src/components/RemotePanel.tsx", import.meta.url), "utf8");
  for (const pat of [/relayChannels/, /\u81ea\u52a8\u9009\u62e9\u6700\u4f18\u901a\u9053|Auto-pick best channel/, /\u6dfb\u52a0\u65b0\u670d\u52a1\u5668\u5730\u5740|Add server address/, /saveChannels/]) {
    assert.match(panel, pat, `面板必须能管理通道列表：${pat}`);
  }
  assert.ok(!/\u4e2d\u7ee7\u5730\u5740\uff08WSS\uff09/.test(panel), "旧的「中继地址（WSS）」字段应已移除");
});

console.log("relay-channels tests passed");
