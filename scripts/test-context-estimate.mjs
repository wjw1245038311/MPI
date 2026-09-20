import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const { postCompactionEstimateFromEntries, cachedPostCompactionEstimate } = await import(
  "../src/main/context-estimate.ts"
);

// ---------------------------------------------------------------------------
// Fixture helpers：带 parent 链的会话条目（镜像 pi JSONL 结构）
// ---------------------------------------------------------------------------

let seq = 0;
function id() {
  return `e${++seq}`;
}
function msg(role, content, extra = {}) {
  const e = { type: "message", id: id(), parentId: null, message: { role, content, ...extra } };
  return e;
}
function link(entry, parent) {
  entry.parentId = parent.id;
  return entry;
}

const ZH_100 = "中".repeat(100); // CJK：estimateTokens ≈ 80 tokens（chars/4 只有 25）
const EN_100 = "a".repeat(100); // ASCII：≈ 25 tokens

// ---------------------------------------------------------------------------
// 1. 无 compaction → undefined
// ---------------------------------------------------------------------------
{
  const a = msg("user", EN_100);
  const b = link(msg("assistant", [{ type: "text", text: ZH_100 }]), a);
  assert.equal(postCompactionEstimateFromEntries([a, b], b.id), undefined);
}

// ---------------------------------------------------------------------------
// 2. compaction + 压缩后无 usage → CJK 感知估算（summary + firstKept 起保留区）
//    便签 100 个中文字 ≈ 80；保留区 user 消息 100 个中文字 ≈ 80 → 合计 ≈ 160。
//    （chars/4 口径只有 50——断言明显高于它，证明走了 CJK 权重。）
// ---------------------------------------------------------------------------
{
  const a = msg("user", EN_100); // 被压缩掉（在 firstKept 之前）
  const b = link(msg("user", ZH_100), a); // firstKept：保留区起点
  const c = link(
    { type: "compaction", id: id(), parentId: null, summary: ZH_100, firstKeptEntryId: b.id, tokensBefore: 999 },
    b,
  );
  const est = postCompactionEstimateFromEntries([a, b, c], c.id);
  assert.ok(est, "应返回估算");
  assert.equal(est.compactionId, c.id);
  // summary(≈80) + kept user(≈80) ≈ 160；允许 ±5 的取整误差。
  assert.ok(Math.abs(est.tokens - 160) <= 5, `expected ~160, got ${est.tokens}`);
  assert.ok(est.tokens > 90, "必须明显高于 chars/4 口径（≈50）");
}

// ---------------------------------------------------------------------------
// 3. 压缩后已有有效 assistant usage → undefined（pi 会报真实 tokens）
// ---------------------------------------------------------------------------
{
  const a = msg("user", EN_100);
  const b = link(msg("user", ZH_100), a);
  const c = link(
    { type: "compaction", id: id(), parentId: null, summary: "s", firstKeptEntryId: b.id },
    b,
  );
  const d = link(
    msg("assistant", [{ type: "text", text: "ok" }], {
      stopReason: "stop",
      usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 1050 },
    }),
    c,
  );
  assert.equal(postCompactionEstimateFromEntries([a, b, c, d], d.id), undefined);
}

// ---------------------------------------------------------------------------
// 4. 压缩后只有 aborted/error/零 usage 的 assistant → 仍估算（镜像 pi 守卫）
// ---------------------------------------------------------------------------
for (const bad of [
  { stopReason: "aborted", usage: { totalTokens: 500 } },
  { stopReason: "error", usage: { totalTokens: 500 } },
  { stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } },
]) {
  const a = msg("user", EN_100);
  const b = link(msg("user", ZH_100), a);
  const c = link({ type: "compaction", id: id(), parentId: null, summary: "s", firstKeptEntryId: b.id }, b);
  const d = link(msg("assistant", [{ type: "text", text: "x" }], bad), c);
  assert.ok(postCompactionEstimateFromEntries([a, b, c, d], d.id), `bad=${JSON.stringify(bad)} 应仍估算`);
}

// ---------------------------------------------------------------------------
// 5. 分支：只算当前 leaf 路径；firstKeptEntryId 之前的条目不计入
//    主链 a→b→compaction(c)→d(leaf)；旁支 b→x（含大段文本）不在路径上。
// ---------------------------------------------------------------------------
{
  const a = msg("user", EN_100); // firstKept 之前 → 不计入
  const b = link(msg("user", ZH_100), a); // firstKept
  const c = link({ type: "compaction", id: id(), parentId: null, summary: "s", firstKeptEntryId: b.id }, b);
  const d = link(msg("assistant", [{ type: "text", text: "hi" }], { stopReason: "aborted", usage: {} }), c); // leaf
  const x = link(msg("user", ZH_100.repeat(50)), b); // 旁支：5000 中文字，绝不能计入
  const est = postCompactionEstimateFromEntries([a, b, c, d, x], d.id);
  assert.ok(est);
  // summary("s"≈1) + kept user(≈80) + assistant "hi"(≈1) ≈ 82；旁支 4000+ tokens 未混入。
  assert.ok(Math.abs(est.tokens - 82) <= 6, `expected ~82, got ${est.tokens}`);
}

// ---------------------------------------------------------------------------
// 6. 条目类型：普通 custom 不进上下文，custom_message / branch_summary / 图片计入
// ---------------------------------------------------------------------------
{
  const a = msg("user", EN_100);
  const b = link(msg("user", "start"), a); // firstKept
  const c = link({ type: "compaction", id: id(), parentId: null, summary: "", firstKeptEntryId: b.id }, b);
  const custom = { type: "custom", id: id(), parentId: c.id, customType: "todo", data: ZH_100 }; // 展示条目 → 0
  const customMsg = link(
    { type: "custom_message", id: id(), parentId: null, content: [{ type: "text", text: ZH_100 }] },
    custom,
  );
  const img = link(msg("user", [{ type: "image" }], {}), customMsg); // 图片 = 1200 tokens
  const est = postCompactionEstimateFromEntries([a, b, c, custom, customMsg, img], img.id);
  assert.ok(est);
  // kept user "start"(≈2) + custom_message(≈80) + image(1200) ≈ 1282（custom 的 80 不计入）
  assert.ok(Math.abs(est.tokens - 1282) <= 6, `expected ~1282, got ${est.tokens}`);
}

// ---------------------------------------------------------------------------
// 7. assistant toolCall：name + arguments JSON 计入
// ---------------------------------------------------------------------------
{
  const a = msg("user", "go"); // firstKept
  const c = link({ type: "compaction", id: id(), parentId: null, summary: "", firstKeptEntryId: a.id }, a);
  const d = link(
    msg("assistant", [{ type: "toolCall", name: "read", arguments: { path: "/tmp/x.txt" } }], { stopReason: "aborted", usage: {} }),
    c,
  );
  const est = postCompactionEstimateFromEntries([a, c, d], d.id);
  assert.ok(est);
  // user "go"(≈1) + toolCall("read"+'{"path":"/tmp/x.txt"}'=24 chars ≈6) ≈ 7
  assert.ok(Math.abs(est.tokens - 7) <= 3, `expected ~7, got ${est.tokens}`);
}

// ---------------------------------------------------------------------------
// 8. cachedPostCompactionEstimate：同 compaction id 命中缓存（只取一次条目），
//    新压缩 → 重新计算。
// ---------------------------------------------------------------------------
{
  const a = msg("user", EN_100);
  const b = link(msg("user", ZH_100), a);
  const c = link({ type: "compaction", id: "C1", parentId: null, summary: "s", firstKeptEntryId: b.id }, b);
  let calls = 0;
  const makeBridge = (entries) => ({
    getEntries: async () => {
      calls++;
      return { entries, leafId: entries[entries.length - 1].id };
    },
  });

  // 第一次：计算并缓存
  let est = await cachedPostCompactionEstimate(makeBridge([a, b, c]), "t1");
  assert.ok(est && est.compactionId === "C1" && est.tokens > 0);
  // 第二次（同 id）：命中缓存，不再取条目
  est = await cachedPostCompactionEstimate(makeBridge([a, b, c]), "t1");
  assert.equal(calls, 1, "第二次应命中缓存");
  // 新压缩 C2 → refresh:true（compaction_end 修正路径的用法）强制重算
  const d = link(msg("user", ZH_100), c);
  const e = link({ type: "compaction", id: "C2", parentId: null, summary: "s2", firstKeptEntryId: d.id }, d);
  est = await cachedPostCompactionEstimate(makeBridge([a, b, c, d, e]), "t1", { refresh: true });
  assert.ok(est && est.compactionId === "C2", "refresh 应重算出新 compaction id");
  assert.equal(calls, 2);
  // 之后不带 refresh → 命中新缓存，不再取条目
  est = await cachedPostCompactionEstimate(makeBridge([a, b, c, d, e]), "t1");
  assert.ok(est && est.compactionId === "C2");
  assert.equal(calls, 2);
}

// ---------------------------------------------------------------------------
// 9. 空/畸形输入不抛错
// ---------------------------------------------------------------------------
{
  assert.equal(postCompactionEstimateFromEntries([], null), undefined);
  assert.equal(postCompactionEstimateFromEntries(null, null), undefined);
  assert.equal(postCompactionEstimateFromEntries([{ type: "session", id: "h" }], null), undefined);
}

console.log("test-context-estimate: all assertions passed");
