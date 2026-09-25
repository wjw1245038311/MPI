// 会话快照内存缓存（Tier 1）：LRU 淘汰 + 容量上限。
//
// 背景：切会话原本是「销毁 + 从零重建」——切回来要主机读一遍 JSONL、渲染、下发整份
// 快照（实测单次 0.3–1.6 MB），期间界面只有一句「加载会话…」。Tier 1 用内存里的
// 快照先把界面铺上，感知延迟归零（网络那一趟照旧）。
//
// 这个类本身很小，但错一处就会「切回旧会话却看到另一个会话的内容」，所以把
// 键序（LRU 语义）与上限钉死。
import assert from "node:assert/strict";

const { SnapshotCache } = await import("../mobile/pwa/src/lib/snapshot-cache.ts");

// --- 1. 基本读写：取回的是同一个 payload，savedAt 可显式给 ----------------------
{
  const cache = new SnapshotCache(3);
  const payload = { id: "t1", messages: [] };
  cache.set("t1", payload, 1_700_000_000_000);
  const hit = cache.get("t1");
  assert.equal(hit.payload, payload, "取回的是原始 payload（不做拷贝，快照只读使用）");
  assert.equal(hit.savedAt, 1_700_000_000_000, "显式 savedAt 被保留（UI 靠它显示「x 分钟前」）");
  assert.equal(cache.has("t1"), true);
  assert.equal(cache.get("nope"), undefined, "未命中返回 undefined");
}

// --- 2. 不传 savedAt 时用当前时间 -------------------------------------------------
{
  const cache = new SnapshotCache(1);
  const before = Date.now();
  cache.set("t1", { id: "t1" });
  const hit = cache.get("t1");
  assert.ok(hit.savedAt >= before && hit.savedAt <= Date.now(), "默认 savedAt 是当前时间");
}

// --- 3. 上限：超出后淘汰**最久未用**的 ------------------------------------------
{
  const cache = new SnapshotCache(2);
  cache.set("a", { id: "a" });
  cache.set("b", { id: "b" });
  cache.set("c", { id: "c" }); // a 最旧 → 被淘汰
  assert.deepEqual(cache.keys(), ["b", "c"], "淘汰最久未用的 a");
  assert.equal(cache.has("a"), false, "被淘汰的取不到");
  assert.equal(cache.get("b").payload.id, "b", "幸存的仍是自己的内容");
}

// --- 4. get 算「最近使用」：访问过的不会被淘汰 -----------------------------------
{
  const cache = new SnapshotCache(2);
  cache.set("a", { id: "a" });
  cache.set("b", { id: "b" });
  cache.get("a"); // a 变成最近使用，b 变成最久未用
  cache.set("c", { id: "c" }); // → 淘汰 b
  assert.deepEqual(cache.keys(), ["a", "c"], "访问过的 a 留存，b 按 LRU 被淘汰");
  assert.equal(cache.has("b"), false);
}

// --- 5. 重复 set 同一个 key：不增长，且内容被替换 ---------------------------------
{
  const cache = new SnapshotCache(2);
  cache.set("a", { id: "a", v: 1 });
  cache.set("a", { id: "a", v: 2 });
  assert.equal(cache.size, 1, "同一 key 不重复占位");
  assert.equal(cache.get("a").payload.v, 2, "内容被最新一次覆盖");
}

// --- 6. delete / clear -----------------------------------------------------------
{
  const cache = new SnapshotCache(3);
  cache.set("a", { id: "a" });
  cache.set("b", { id: "b" });
  cache.delete("a");
  assert.equal(cache.has("a"), false, "delete 生效");
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0, "clear 清空（切主机 / 断连 / 卸载时调用）");
  assert.deepEqual(cache.keys(), []);
}

// --- 7. limit 必须是正数（配错上限会静默把缓存变成永远空的） ---------------------
{
  assert.throws(() => new SnapshotCache(0), /limit must be >= 1/, "limit=0 直接抛，不静默失效");
  const one = new SnapshotCache(1);
  one.set("a", { id: "a" });
  one.set("b", { id: "b" });
  assert.deepEqual(one.keys(), ["b"], "limit=1 时只留最后一个");
}

console.log("ok 1 - 快照缓存：读写 / 默认时间戳 / LRU 淘汰 / 覆盖 / delete / clear / limit 校验");
console.log("pwa snapshot cache tests passed");
