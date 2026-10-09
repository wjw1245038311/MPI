/**
 * S4 选路纯函数（mobile/pwa/src/lib/relay-select.ts），S6 起顺序规则调整：
 *   ① 候选顺序 = 主机下发的 relayUrls 原序 → lastGood（回落）→ 单值；去重去空
 *   ② `mergeHostRelayInfo`：host.info 列表合并（顺序以主机为准；lastGood 只在降级时保留）
 *   ③ 逐条尝试、每条独立超时；全失败抛出可读错误
 */
import assert from "node:assert/strict";
import test from "node:test";

const { relayCandidates, pickRelayUrl, mergeHostRelayInfo, remainingCandidates, connectFirstReachable } = await import("../mobile/pwa/src/lib/relay-select.ts");

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
