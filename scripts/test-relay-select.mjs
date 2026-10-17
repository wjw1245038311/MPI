/**
 * S4 选路纯函数（mobile/pwa/src/lib/relay-select.ts），S6 起顺序规则调整：
 *   ① 候选顺序 = 主机下发的 relayUrls 原序 → lastGood（回落）→ 单值；去重去空
 *   ② `mergeHostRelayInfo`：host.info 列表合并（顺序以主机为准；lastGood 只在降级时保留）
 *   ③ 逐条尝试、每条独立超时；全失败抛出可读错误
 */
import assert from "node:assert/strict";
import test from "node:test";

const { relayCandidates, sameOriginRelayUrl, isPrivateRelayUrl, shouldSwitchToBetterPath, pickRelayUrl, mergeHostRelayInfo, remainingCandidates, connectFirstReachable } = await import("../mobile/pwa/src/lib/relay-select.ts");

test("S6 候选顺序：主机下发的顺序优先，上次可用退为回落，单值最后；去重去空", () => {
  assert.deepEqual(
    relayCandidates({ relayUrl: "ws://c/ws", relayUrls: ["ws://a/ws", "ws://b/ws"], lastGoodRelayUrl: "ws://b/ws" }),
    ["ws://a/ws", "ws://b/ws", "ws://c/ws"],
    "主机顺序原样在前（lastGood 已在列表内则不重复）",
  );
  assert.deepEqual(relayCandidates({ relayUrl: "ws://a/ws", relayUrls: ["ws://a/ws"] }), ["ws://a/ws"], "重复只留一个");
  assert.deepEqual(relayCandidates({ relayUrl: "", relayUrls: ["", "  "] }), [], "空串/空白一律剔除");
  assert.deepEqual(relayCandidates({ relayUrl: " ws://a/ws ", relayUrls: undefined }), ["ws://a/ws"], "两端空白要 trim");
  assert.deepEqual(
    relayCandidates({ relayUrl: "ws://c/ws", relayUrls: ["ws://a/ws"], lastGoodRelayUrl: "ws://gone/ws" }),
    ["ws://a/ws", "ws://gone/ws", "ws://c/ws"],
    "不在主机列表里的上次可用退为回落点，但仍先于单值字段",
  );
  assert.deepEqual(
    relayCandidates({ relayUrl: "ws://c/ws", lastGoodRelayUrl: "ws://b/ws" }),
    ["ws://b/ws", "ws://c/ws"],
    "旧记录没有 relayUrls → 保留 S4 的「上次可用优先」",
  );
});

test("S6 重连取址：主机首选优先于上次可用", () => {
  assert.equal(pickRelayUrl({ relayUrl: "ws://c/ws", relayUrls: ["ws://a/ws"] }), "ws://a/ws");
  assert.equal(
    pickRelayUrl({ relayUrl: "ws://c/ws", relayUrls: ["ws://a/ws"], lastGoodRelayUrl: "ws://b/ws" }),
    "ws://a/ws",
    "桌面改了顺序 → 手机重连即跟随",
  );
  assert.equal(pickRelayUrl({ relayUrl: "ws://c/ws", lastGoodRelayUrl: "ws://b/ws" }), "ws://b/ws");
  assert.equal(pickRelayUrl({ relayUrl: "ws://c/ws" }), "ws://c/ws");
});

test("S6 host.info 合并：顺序以主机为准；lastGood 只在降级时保留", () => {
  const base = { relayUrl: "ws://old/ws", relayUrls: ["ws://old/ws"], lastGoodRelayUrl: "ws://cf/ws" };
  // 直连主机首选成功 → 没有降级，清掉回落点
  assert.deepEqual(mergeHostRelayInfo(base, ["ws://ecs/ws", "ws://cf/ws"], { connectedUrl: "ws://ecs/ws" }), {
    relayUrl: "ws://old/ws",
    relayUrls: ["ws://ecs/ws", "ws://cf/ws"],
  });
  // 本次连的是次选（发生过降级） → 记为回落点
  assert.deepEqual(mergeHostRelayInfo(base, ["ws://ecs/ws", "ws://cf/ws"], { connectedUrl: "ws://cf/ws" }), {
    relayUrl: "ws://old/ws",
    relayUrls: ["ws://ecs/ws", "ws://cf/ws"],
    lastGoodRelayUrl: "ws://cf/ws",
  });
  // 没有 connectedUrl：lastGood === 主机首选 → 也清
  assert.equal(mergeHostRelayInfo({ relayUrl: "ws://a/ws", lastGoodRelayUrl: "ws://ecs/ws" }, ["ws://ecs/ws"]).lastGoodRelayUrl, undefined);
  // 主机没给有效列表 → 原样返回（不动本地）
  assert.equal(mergeHostRelayInfo(base, ["", "  "]), base);
  // 去重去空，顺序保持
  assert.deepEqual(mergeHostRelayInfo(base, [" ws://a/ws ", "ws://a/ws", ""], {}).relayUrls, ["ws://a/ws"]);
});

test("HTTPS 页面下剔除 ws:// 候选（混合内容会被浏览器拦掉）", () => {
  const input = { relayUrl: "ws://plain/ws", relayUrls: ["ws://plain/ws", "wss://tls/ws"] };
  assert.deepEqual(relayCandidates(input, { secureContext: true }), ["wss://tls/ws"], "https 页面只留 wss");
  assert.deepEqual(
    relayCandidates(input, { secureContext: false }),
    ["ws://plain/ws", "wss://tls/ws"],
    "http 页面两条都在（原生 App / node 测试同理）",
  );
  assert.deepEqual(remainingCandidates(input, [], { secureContext: true }), ["wss://tls/ws"], "降级重试同样遵守该过滤");
  assert.equal(pickRelayUrl({ ...input, relayUrl: "ws://plain/ws" }, { secureContext: true }), "wss://tls/ws", "重连取址同理");
});

test("S4 降级重试：remainingCandidates 去掉已试过的，顺序不变", () => {
  const input = { relayUrl: "ws://c/ws", relayUrls: ["ws://a/ws", "ws://b/ws"] };
  assert.deepEqual(remainingCandidates(input, []), ["ws://a/ws", "ws://b/ws", "ws://c/ws"]);
  assert.deepEqual(remainingCandidates(input, ["ws://a/ws"]), ["ws://b/ws", "ws://c/ws"]);
  assert.deepEqual(remainingCandidates(input, ["ws://a/ws", "ws://b/ws", "ws://c/ws"]), [], "候选耗尽 → 空（调用方回落）");
  assert.deepEqual(remainingCandidates(input, [" ws://a/ws "]), ["ws://b/ws", "ws://c/ws"], "比较前要 trim");
});

test("逐条尝试：第一条成功即用；失败降级到下一条", async () => {
  const tried = [];
  const ok = await connectFirstReachable(["ws://a/ws", "ws://b/ws"], async (url) => {
    tried.push(url);
    if (url === "ws://a/ws") throw new Error("refused");
    return `connected:${url}`;
  });
  assert.deepEqual(tried, ["ws://a/ws", "ws://b/ws"], "要先试第一条");
  assert.equal(ok.url, "ws://b/ws");
  assert.deepEqual(ok.failed, ["ws://a/ws"], "失败列表用于诊断");
  assert.equal(ok.value, "connected:ws://b/ws");
});

test("逐条尝试：某条卡住时按超时降级（不等它自然失败）", async () => {
  const started = Date.now();
  const ok = await connectFirstReachable(
    ["ws://hang/ws", "ws://fast/ws"],
    (url) => (url === "ws://hang/ws" ? new Promise(() => {}) : Promise.resolve("ok")),
    { timeoutMs: 120 },
  );
  assert.equal(ok.url, "ws://fast/ws");
  assert.ok(Date.now() - started >= 100, "应该真的等过超时");
  assert.deepEqual(ok.failed, ["ws://hang/ws"]);
});

test("逐条尝试：全失败时抛出可读错误", async () => {
  await assert.rejects(
    () => connectFirstReachable(["ws://a/ws", "ws://b/ws"], async () => Promise.reject(new Error("nope")), { timeoutMs: 80 }),
    /nope/,
  );
  await assert.rejects(() => connectFirstReachable([], async () => Promise.resolve("x")), /所有通道都连不上/);
});

console.log("relay-select tests passed");

test("同源候选：https 页面排最前（页面能加载 = 必然可达；明文局域网候选在这类页面里本来就会被剔除）", () => {
  const input = { relayUrl: "ws://lan:9001/ws", relayUrls: ["ws://lan:9001/ws", "wss://ecs:9443/ws"] };
  assert.deepEqual(
    relayCandidates(input, { secureContext: true, location: { origin: "https://workstation.tail38d5a.ts.net:8765" } }),
    ["wss://workstation.tail38d5a.ts.net:8765/ws", "wss://ecs:9443/ws"],
    "https 页面：同源 wss 最前，明文局域网被剔除",
  );
});

test("同源候选：明文页面排在主机列表之后（局域网通常比同源更快）", () => {
  const input = { relayUrl: "ws://lan:9001/ws", relayUrls: ["ws://lan:9001/ws", "ws://ecs:10445/ws"] };
  assert.deepEqual(
    relayCandidates(input, { secureContext: false, location: { origin: "http://47.97.28.110:10445" } }),
    ["ws://lan:9001/ws", "ws://ecs:10445/ws", "ws://47.97.28.110:10445/ws"],
    "明文页面：主机顺序优先，同源（这里是 ECS）殿后且去重",
  );
});

test("同源候选：非 http(s) 页面不给（本地文件 / 无 location）", () => {
  assert.equal(sameOriginRelayUrl({ origin: "file:///x" }), null);
  assert.equal(sameOriginRelayUrl({ origin: "" }), null);
  assert.equal(sameOriginRelayUrl(undefined), null);
  assert.equal(sameOriginRelayUrl({ origin: "https://h:8765" }), "wss://h:8765/ws", "https → wss，同主机同端口，路径 /ws");
});

test("安全上下文优先级：同源先（必然可达），其次局域网/tailnet TLS，再次公网", () => {
  const input = {
    relayUrls: ["ws://10.215.35.72:9001/ws", "wss://10.215.35.72:9443/ws", "ws://47.97.28.110:10445/ws", "wss://47.97.28.110:9443/ws"],
    relayUrl: "ws://47.97.28.110:10445/ws",
  };
  assert.deepEqual(
    relayCandidates(input, { secureContext: true, location: { origin: "https://47.97.28.110:9443" } }),
    ["wss://47.97.28.110:9443/ws", "wss://10.215.35.72:9443/ws"],
    "页面从中继打开：先连同源（必然可达），近端候选留给连上后的择优（minibox 实测：先撞不在网段的地址会拖长握手窗口）",
  );
  assert.deepEqual(
    relayCandidates(
      { relayUrls: ["wss://10.215.35.72:9443/ws", "wss://relay.example.com:9443/ws"] },
      { secureContext: true, location: { origin: "https://relay.example.com:9443" } },
    ),
    ["wss://relay.example.com:9443/ws", "wss://10.215.35.72:9443/ws"],
    "同源第一，局域网 TLS 第二",
  );
  assert.equal(isPrivateRelayUrl("wss://192.168.1.5:9443/ws"), true);
  assert.equal(isPrivateRelayUrl("wss://100.90.55.36:9443/ws"), true, "tailnet 地址也算近端");
  assert.equal(isPrivateRelayUrl("wss://47.97.28.110:9443/ws"), false);
  assert.equal(isPrivateRelayUrl("wss://relay.example.com/ws"), false);
});

test("后台择优：只朝更近的方向切（公网 → 局域网），已在局域网则不折腾", () => {
  const ordered = ["wss://10.215.35.72:9443/ws", "wss://47.97.28.110:9443/ws"];
  assert.equal(
    shouldSwitchToBetterPath("wss://47.97.28.110:9443/ws", ordered),
    "wss://10.215.35.72:9443/ws",
    "当前在公网中继、局域网 TLS 可用 → 切过去",
  );
  assert.equal(shouldSwitchToBetterPath("wss://10.215.35.72:9443/ws", ordered), null, "已经在局域网 → 不动");
  assert.equal(
    shouldSwitchToBetterPath("ws://10.215.35.72:9001/ws", ["wss://47.97.28.110:9443/ws"]),
    null,
    "首选不是局域网 → 不做反向切换（离开网络交给正常重连回落）",
  );
  assert.equal(shouldSwitchToBetterPath("wss://a/ws", []), null, "没有候选 → 不动");
});
