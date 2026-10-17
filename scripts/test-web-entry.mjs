/**
 * 网页入口（`src/main/remote/web-entry.ts`）：候选组装 + 探测 + 单入口选择。
 *
 * 钉住的约定（2026-10 收敛后）：
 *  ① 入口只来自**中继**（自定义优先，其次内置；内置要激活码）；
 *  ② 探测只证明“这个 origin 现在真的托管着 PWA”，探不到**不删入口**，只标 verified=false
 *     （否则中继瞬断一下，用户就看不到唯一的入口了）；
 *  ③ `resolveWebEntry` 取第一个探测通过的；全不通过返回第一个候选（未验证）；空列表返回 null。
 */
import assert from "node:assert/strict";

const { httpOriginOf, webEntryCandidates, localEntryCandidates, probeWebEntry, resolveWebEntry } = await import(
  "../src/main/remote/web-entry.ts"
);

// ---- ① origin 推导 -------------------------------------------------------------
assert.equal(httpOriginOf("wss://relay.example.com:9443/ws"), "https://relay.example.com:9443");
assert.equal(httpOriginOf("ws://192.168.1.5:9001/ws"), "http://192.168.1.5:9001");
assert.equal(httpOriginOf("https://relay.example.com/"), "https://relay.example.com");
assert.equal(httpOriginOf(""), null);
assert.equal(httpOriginOf("not-a-url"), null);

// ---- ② 候选组装 ---------------------------------------------------------------
const empty = webEntryCandidates({});
assert.deepEqual(empty, [], "没有中继就没有网页入口");

const customOnly = webEntryCandidates({ customRelayUrl: "wss://my-relay.example.com/ws" });
assert.deepEqual(customOnly, [{ origin: "https://my-relay.example.com", source: "custom", scope: "any", verified: false }]);

const builtinNoCode = webEntryCandidates({ builtinPhoneUrls: ["wss://ecs.example.com:9443/ws"], authCode: "" });
assert.deepEqual(builtinNoCode, [], "没激活码就不该把内置服务器当入口");

// 明文端口会被中继照样返回静态文件，但那是非安全上下文 → 必须剔除
const plainDropped = webEntryCandidates({
  builtinPhoneUrls: ["ws://47.97.28.110:10445/ws", "wss://47.97.28.110:9443/ws"],
  authCode: "CODE",
});
assert.deepEqual(
  plainDropped.map((e) => e.origin),
  ["https://47.97.28.110:9443"],
  "ws:// 候选必须丢弃（http 页面里 crypto.subtle 不可用，E2E 会挂）",
);
const customPlain = webEntryCandidates({ customRelayUrl: "ws://relay.example.com:9001/ws" });
assert.deepEqual(customPlain, [], "自定义中继只给明文地址 = 没有网页入口");

const builtinWithCode = webEntryCandidates({
  builtinPhoneUrls: ["wss://ecs.example.com:9443/ws", "wss://ecs.ts.net:9443/ws"],
  authCode: "CODE",
});
assert.deepEqual(
  builtinWithCode.map((e) => e.origin),
  ["https://ecs.example.com:9443", "https://ecs.ts.net:9443"],
  "内置候选按描述给的顺序（tailnet 在前），全部保留给探测挑",
);
assert.ok(builtinWithCode.every((e) => e.source === "builtin"));

const both = webEntryCandidates({
  customRelayUrl: "wss://my-relay.example.com/ws",
  builtinPhoneUrls: ["wss://ecs.example.com:9443/ws"],
  authCode: "CODE",
});
assert.equal(both[0].source, "custom", "自定义中继优先（用户显式配的）");
assert.equal(both.length, 2);

// 同址去重：自定义 == 内置之一时只留一条
const dup = webEntryCandidates({
  customRelayUrl: "wss://ecs.example.com:9443/ws",
  builtinPhoneUrls: ["wss://ecs.example.com:9443/ws"],
  authCode: "CODE",
});
assert.equal(dup.length, 1);

// ---- ②b 本机入口 -------------------------------------------------------------
const locals = localEntryCandidates({ addresses: ["10.0.0.5", "192.168.1.9"], tailnet: "100.90.55.36", tlsPort: 9443 });
assert.deepEqual(
  locals.map((e) => e.origin),
  ["https://100.90.55.36:9443", "https://10.0.0.5:9443", "https://192.168.1.9:9443"],
  "tailnet 在前（地址固定），内网 IP 在后",
);
assert.ok(locals.every((e) => e.scope === "local" && e.source === "local"));
assert.deepEqual(localEntryCandidates({ addresses: ["10.0.0.5"], lanEnabled: false }), [], "局域网监听没开就没有本机入口");
assert.deepEqual(localEntryCandidates({ addresses: ["10.0.0.5"], tailnet: "10.0.0.5" }), [
  { origin: "https://10.0.0.5:9443", source: "local", scope: "local", verified: false },
], "同址去重 + 默认端口 9443");

// ---- ③ 探测 -------------------------------------------------------------------
const manifestOk = async (url) => ({
  status: 200,
  body: url.endsWith("/manifest.webmanifest") ? '{"name":"MPI Mobile"}' : "",
});
const probed = await probeWebEntry({ origin: "https://a.example.com", source: "builtin", scope: "any", verified: false }, {
  requestImpl: manifestOk,
});
assert.equal(probed.verified, true, "200 + manifest 内容 → verified");

const notFound = await probeWebEntry({ origin: "https://a.example.com", source: "builtin", scope: "any", verified: false }, {
  requestImpl: async () => ({ status: 404, body: "not found" }),
});
assert.equal(notFound.verified, false, "404 → 未验证（但入口还在）");
assert.equal(notFound.origin, "https://a.example.com", "探测失败不得丢掉入口");

const throws = await probeWebEntry({ origin: "https://a.example.com", source: "builtin", scope: "any", verified: false }, {
  requestImpl: async () => {
    throw new Error("ECONNREFUSED");
  },
});
assert.equal(throws.verified, false, "网络错 → 未验证，不抛");

const htmlNotManifest = await probeWebEntry({ origin: "https://a.example.com", source: "builtin", scope: "any", verified: false }, {
  requestImpl: async () => ({ status: 200, body: "<!doctype html><html></html>" }),
});
assert.equal(htmlNotManifest.verified, false, "200 但返回 HTML（不是 PWA）→ 未验证");

// ---- ④ 选择 -------------------------------------------------------------------
const picked = await resolveWebEntry(builtinWithCode, {
  requestImpl: async (url) => ({
    status: url.startsWith("https://ecs.ts.net") ? 200 : 500,
    body: url.startsWith("https://ecs.ts.net") ? '{"name":"MPI Mobile"}' : "",
  }),
});
assert.equal(picked?.origin, "https://ecs.ts.net:9443", "取第一个探测通过的候选");
assert.equal(picked?.verified, true);

const noneVerified = await resolveWebEntry(builtinWithCode, {
  requestImpl: async () => ({ status: 503, body: "" }),
});
assert.equal(noneVerified?.origin, "https://ecs.example.com:9443", "全不通过 → 回第一个候选");
assert.equal(noneVerified?.verified, false);

assert.equal(await resolveWebEntry([], {}), null, "没有候选就返回 null");

console.log("web-entry: 全部检查通过");
