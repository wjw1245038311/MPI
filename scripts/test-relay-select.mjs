/**
 * S4 选路纯函数（mobile/pwa/src/lib/relay-select.ts）：
 *   ① 候选顺序 = 上次可用优先 → 票序 → 单值；去重去空
 *   ② 逐条尝试、每条独立超时；全失败抛出可读错误
 */
import assert from "node:assert/strict";
import test from "node:test";

const { relayCandidates, pickRelayUrl, connectFirstReachable } = await import("../mobile/pwa/src/lib/relay-select.ts");

test("候选顺序：上次可用优先，然后票序，最后单值；去重去空", () => {
  assert.deepEqual(
    relayCandidates({ relayUrl: "ws://c/ws", relayUrls: ["ws://a/ws", "ws://b/ws"], lastGoodRelayUrl: "ws://b/ws" }),
    ["ws://b/ws", "ws://a/ws", "ws://c/ws"],
    "上次可用的排最前，票序保持，单值补末尾",
  );
  assert.deepEqual(relayCandidates({ relayUrl: "ws://a/ws", relayUrls: ["ws://a/ws"] }), ["ws://a/ws"], "重复只留一个");
  assert.deepEqual(relayCandidates({ relayUrl: "", relayUrls: ["", "  "] }), [], "空串/空白一律剔除");
  assert.deepEqual(relayCandidates({ relayUrl: " ws://a/ws ", relayUrls: undefined }), ["ws://a/ws"], "两端空白要 trim");
  assert.deepEqual(relayCandidates({ relayUrl: "ws://c/ws", relayUrls: ["ws://a/ws"], lastGoodRelayUrl: "ws://gone/ws" }), ["ws://gone/ws", "ws://a/ws", "ws://c/ws"], "上次可用即使已不在票里也先试它");
});

test("重连取址：无 lastGood 时回落候选首位", () => {
  assert.equal(pickRelayUrl({ relayUrl: "ws://c/ws", relayUrls: ["ws://a/ws"] }), "ws://a/ws");
  assert.equal(pickRelayUrl({ relayUrl: "ws://c/ws", lastGoodRelayUrl: "ws://b/ws" }), "ws://b/ws");
  assert.equal(pickRelayUrl({ relayUrl: "ws://c/ws" }), "ws://c/ws");
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
