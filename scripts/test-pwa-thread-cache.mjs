// 会话快照持久缓存（Tier 2）的**纯逻辑**：容量上限 / prune 顺序 / 失败静默。
//
// 为什么用 MemoryStore 而不是真的 IndexedDB：Node 没有 IndexedDB，而项目约定不引入
// `fake-indexeddb` 这类依赖。存储后端已抽象成 CacheStore 接口，所以这里测的是真正
// 容易写错的那部分（上限、淘汰顺序、坏数据不喂给归约器）。IdbStore 的实现细节
// （复合主键、双 store、事务）靠真实浏览器验证。
import assert from "node:assert/strict";

const { ThreadCache, DEFAULT_MAX_ENTRIES } = await import("../mobile/pwa/src/lib/thread-cache.ts");

const THREAD = "t1";
const HOST = "host-a";
/** 与实现同一个容量度量（thread-cache.ts 用 json.length）——测试里自校准用，
 *  避免手算字节数造成脆弱断言。 */
const sizeOf = (payload) => JSON.stringify(payload).length;
const snap = (id, messageCount = 2) => ({
  id,
  projectId: "p1",
  title: `title ${id}`,
  preview: "",
  updatedAt: 1,
  messageCount,
  state: "idle",
  permission: "sandbox",
  messages: Array.from({ length: messageCount }, (_, i) => ({ id: `m${i}`, role: "user", text: "x" })),
});

/** CacheStore 的内存实现（测试专用，替掉 IndexedDB）。 */
class MemoryStore {
  constructor() {
    this.entries = new Map();
    this.failRead = false;
    this.failWrite = false;
  }
  key(hostId, threadId) {
    return `${hostId}\u0000${threadId}`;
  }
  async read(hostId, threadId) {
    if (this.failRead) throw new Error("body unreadable");
    const hit = this.entries.get(this.key(hostId, threadId));
    return hit ? { meta: hit.meta, json: hit.json } : null;
  }
  async write(entry) {
    if (this.failWrite) throw new Error("quota exceeded");
    this.entries.set(this.key(entry.meta.hostId, entry.meta.threadId), { meta: entry.meta, json: entry.json });
  }
  async listMeta(hostId) {
    return [...this.entries.values()].filter((e) => e.meta.hostId === hostId).map((e) => e.meta);
  }
  async remove(hostId, threadId) {
    this.entries.delete(this.key(hostId, threadId));
  }
  async clear() {
    this.entries.clear();
  }
  /** 塞一条绕过 ThreadCache 的坏数据，模拟「旧版本写的残留」。 */
  putRaw(hostId, threadId, json, bytes = 10) {
    this.entries.set(this.key(hostId, threadId), {
      meta: { hostId, threadId, savedAt: Date.now(), bytes },
      json,
    });
  }
  get size() {
    return this.entries.size;
  }
}

// --- 1. 往返：写进去读出来是同一份快照 --------------------------------------------
{
  const store = new MemoryStore();
  const cache = new ThreadCache(store);
  const payload = snap("t1", 3);
  await cache.write(HOST, THREAD, payload, 1_700_000_000_000);

  const hit = await cache.read(HOST, THREAD);
  assert.deepEqual(hit.snapshot, payload, "读回的快照与写入时一致");
  assert.equal(hit.savedAt, 1_700_000_000_000, "savedAt 被保留（UI 靠它显示「x 分钟前」）");
}

// --- 2. 未命中返回 null（不是抛错） ----------------------------------------------
{
  const cache = new ThreadCache(new MemoryStore());
  assert.equal(await cache.read(HOST, "never-cached"), null);
}

// --- 3. 单条超 maxBytesPerEntry：整个跳过（不写、不报错） -------------------------
{
  const store = new MemoryStore();
  const small = snap("small", 1);
  // 阈值定在「基准条目 + 10」：small 能进，big（多了几百字节）进不去。
  const cache = new ThreadCache(store, { maxBytesPerEntry: sizeOf(small) + 10 });
  const big = { ...snap("big", 2), preview: "x".repeat(400) };
  await cache.write(HOST, THREAD, big);
  assert.equal(store.size, 0, "超单条上限的快照不缓存（塞进去只会撑爆配额）");

  await cache.write(HOST, THREAD, small);
  assert.equal(store.size, 1, "正常大小的仍然写进去");
}

// --- 4. maxEntries：超出后淘汰最旧的 ----------------------------------------------
{
  const store = new MemoryStore();
  const cache = new ThreadCache(store, { maxEntries: 3 });
  for (let i = 1; i <= 5; i++) {
    await cache.write(HOST, `t${i}`, snap(`t${i}`), 1_000 + i); // 时间递增
  }
  const metas = await store.listMeta(HOST);
  const ids = metas.map((m) => m.threadId).sort();
  assert.deepEqual(ids, ["t3", "t4", "t5"], "只留最新的 3 条，t1/t2 被淘汰");
  assert.equal(await cache.read(HOST, "t1"), null, "被淘汰的读不到");
  assert.notEqual(await cache.read(HOST, "t5"), null, "最新的还在");
}

// --- 5. maxBytesTotal：按「由新到旧」累计，超预算的删掉 --------------------------
{
  const store = new MemoryStore();
  const pad = "y".repeat(50);
  // 预算 = 刚好 3 条：新→旧累计到第 4 条时超预算，于是只剩最新的 3 条。
  const one = sizeOf({ ...snap("tN"), preview: pad });
  const cache = new ThreadCache(store, { maxEntries: 100, maxBytesTotal: one * 3 + 1 });
  for (let i = 1; i <= 5; i++) {
    await cache.write(HOST, `t${i}`, { ...snap(`t${i}`), preview: pad }, 1_000 + i);
  }
  const ids = (await store.listMeta(HOST)).map((m) => m.threadId).sort();
  assert.deepEqual(ids, ["t3", "t4", "t5"], "总量超预算时从最旧的开始删，留下最新的 3 条");
}

// --- 6. 换主机不互相影响（上限按主机各算） ---------------------------------------
{
  const store = new MemoryStore();
  const cache = new ThreadCache(store, { maxEntries: 2 });
  await cache.write("host-a", "t1", snap("t1"), 1_000);
  await cache.write("host-a", "t2", snap("t2"), 2_000);
  await cache.write("host-a", "t3", snap("t3"), 3_000);
  await cache.write("host-b", "t1", snap("t1"), 4_000);

  assert.deepEqual((await store.listMeta("host-a")).map((m) => m.threadId).sort(), ["t2", "t3"], "host-a 只留 2 条");
  assert.deepEqual((await store.listMeta("host-b")).map((m) => m.threadId), ["t1"], "host-b 不受 host-a 的淘汰影响");
}

// --- 7. 写失败静默（配额满 / 隐私模式不能把主流程带崩） ---------------------------
{
  const store = new MemoryStore();
  store.failWrite = true;
  const cache = new ThreadCache(store);
  await cache.write(HOST, THREAD, snap("t1")); // 不应抛出
  assert.equal(store.size, 0, "写失败就是没缓存，仅此而已");
}

// --- 8. 读失败即删（损坏的缓存留着只会每次启动重试） -----------------------------
{
  const store = new MemoryStore();
  const cache = new ThreadCache(store);
  await cache.write(HOST, THREAD, snap("t1"));
  store.failRead = true;
  assert.equal(await cache.read(HOST, THREAD), null, "读失败返回 null");
  assert.equal(store.size, 0, "读失败顺手删掉这条坏缓存");
}

// --- 9. 坏数据不喂给归约器：JSON 残缺 / 形状不对，都要删掉 -----------------------
{
  const store = new MemoryStore();
  const cache = new ThreadCache(store);
  store.putRaw(HOST, "broken-json", "{not json");
  assert.equal(await cache.read(HOST, "broken-json"), null, "解析失败返回 null");
  assert.equal(store.size, 0, "解析失败的缓存被删除");

  store.putRaw(HOST, "wrong-shape", JSON.stringify({ id: "x" })); // 没有 messages 数组
  assert.equal(await cache.read(HOST, "wrong-shape"), null, "形状不对返回 null（协议升级后的旧缓存）");
  assert.equal(store.size, 0, "形状不对的也被删除");
}

// --- 10. deleteHost / clear -------------------------------------------------------
{
  const store = new MemoryStore();
  const cache = new ThreadCache(store);
  await cache.write("host-a", "t1", snap("t1"));
  await cache.write("host-a", "t2", snap("t2"));
  await cache.write("host-b", "t1", snap("t1"));

  await cache.deleteHost("host-a");
  assert.equal((await store.listMeta("host-a")).length, 0, "deleteHost 清掉该主机全部快照");
  assert.equal((await store.listMeta("host-b")).length, 1, "其他主机不受影响");

  await cache.clear();
  assert.equal(store.size, 0, "clear 清空全部");
}

// --- 11. 默认上限与原生端一致（20 条） -------------------------------------------
{
  assert.equal(DEFAULT_MAX_ENTRIES, 20, "每主机 20 条 —— 与原生 ThreadCache 保持一致");
}

console.log("ok 1 - 快照持久缓存：往返 / 超限跳过 / LRU 淘汰 / 总量预算 / 按主机隔离");
console.log("ok 2 - 失败模式：写失败静默、读失败即删、坏数据不喂给归约器");
console.log("pwa thread cache tests passed");
