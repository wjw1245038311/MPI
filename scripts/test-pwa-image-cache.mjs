// 图片字节缓存（PWA）：命中零请求、并发去重、双上限淘汰、revoke 不漏。
//
// 背景（docs/MOBILE-IMAGE-KEY.md）：2026-11-06 起 image 块只发元数据（key/thumb/lqip），
// 字节由客户端可见时拉。滚动会反复挂载/卸载同一张图，不缓存就比内联还慢，还会把中继
// 流量打满；但缓存太大又会把手机内存吃掉（所以是「张数 + 估算字节」双上限）。
//
// 这层不能复用 attachment-fetch 的 urlCache：那个上限是 2，给几十 MB 的视频/文件定的，
// 混用只会互相挤掉。
import assert from "node:assert/strict";

// objectURL 在 node 里存在，但这里要能数 revoke 次数（防泄漏是这层的核心不变量）。
let seq = 0;
const revoked = [];
globalThis.URL.createObjectURL = () => `blob:image-${++seq}`;
globalThis.URL.revokeObjectURL = (url) => {
  revoked.push(url);
};

const { IMAGE_CACHE_MAX_BYTES, IMAGE_CACHE_MAX_ENTRIES, clearImageCache, imageCacheStats, loadImageUrl, peekImageUrl } =
  await import("../mobile/pwa/src/lib/image-cache.ts");

const bytes = (n) => new Uint8Array(n);

// --- 1. 命中缓存：同一个名字只拉一次 -----------------------------------------
{
  clearImageCache();
  let calls = 0;
  const url = await loadImageUrl("thumb-a.jpg", "image/jpeg", {
    request: async () => {
      calls += 1;
      return bytes(1000);
    },
  });
  assert.match(url, /^blob:/, "返回可直接给 img.src 的 objectURL");
  const again = await loadImageUrl("thumb-a.jpg", "image/jpeg", {
    request: async () => {
      calls += 1;
      return bytes(1000);
    },
  });
  assert.equal(again, url, "第二次命中缓存，返回同一个 URL");
  assert.equal(calls, 1, "只发了一次附件请求");
  assert.equal(peekImageUrl("thumb-a.jpg"), url, "peek 能命中（可见性判断用）");
  assert.equal(peekImageUrl("nope.jpg"), null);
  assert.deepEqual(imageCacheStats(), { entries: 1, bytes: 1000 });
}

// --- 2. 并发复用：同一张图同时挂载两次，只拉一次 ----------------------------
{
  clearImageCache();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const request = async () => {
    calls += 1;
    await gate;
    return bytes(500);
  };
  const first = loadImageUrl("same.jpg", "image/jpeg", { request });
  const second = loadImageUrl("same.jpg", "image/jpeg", { request });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, "并发请求复用同一个结果");
  assert.equal(calls, 1, "并发只发一次请求（否则一屏同时挂载会拉两遍）");
}

// --- 3. 张数上限：超了从最久未用开始淘汰，并 revoke 旧 URL -------------------
{
  clearImageCache();
  revoked.length = 0;
  const urls = [];
  for (let i = 0; i < IMAGE_CACHE_MAX_ENTRIES + 5; i += 1) {
    urls.push(await loadImageUrl(`img-${i}.jpg`, "image/jpeg", { request: async () => bytes(10) }));
  }
  assert.equal(imageCacheStats().entries, IMAGE_CACHE_MAX_ENTRIES, "张数被压在上限内");
  assert.equal(peekImageUrl("img-0.jpg"), null, "最旧的 5 张已被淘汰");
  assert.equal(peekImageUrl("img-5.jpg"), urls[5], "较新的仍在缓存里");
  assert.equal(revoked.length, 5, "淘汰的 objectURL 必须 revoke（否则 Blob 不随 GC 释放）");
  assert.equal(revoked[0], urls[0], "revoke 的正是被淘汰那张");
}

// --- 4. 字节上限：大图进来会把旧图挤掉 --------------------------------------
{
  clearImageCache();
  revoked.length = 0;
  const chunk = Math.floor(IMAGE_CACHE_MAX_BYTES / 3) + 1;
  const a = await loadImageUrl("big-a.jpg", "image/jpeg", { request: async () => bytes(chunk) });
  const b = await loadImageUrl("big-b.jpg", "image/jpeg", { request: async () => bytes(chunk) });
  const c = await loadImageUrl("big-c.jpg", "image/jpeg", { request: async () => bytes(chunk) });
  assert.ok(imageCacheStats().bytes <= IMAGE_CACHE_MAX_BYTES, "总字节压在上限内");
  assert.equal(peekImageUrl("big-a.jpg"), null, "最先的已被淘汰（3 张就超总预算）");
  assert.equal(peekImageUrl("big-c.jpg"), c, "刚进来的那张必须保留");
  assert.ok(revoked.includes(a), "被挤掉的 a 要 revoke");
  assert.ok(!revoked.includes(c) && !revoked.includes(b), "留下的不 revoke");
}

// --- 5. 同名重新拉取：旧 URL 立刻 revoke，不泄漏 ----------------------------
{
  clearImageCache();
  revoked.length = 0;
  const first = await loadImageUrl("dup.jpg", "image/jpeg", { request: async () => bytes(100) });
  clearImageCache(); // 模拟缓存被清理后再拉同名（例如换主机/重新配对）
  const second = await loadImageUrl("dup.jpg", "image/jpeg", { request: async () => bytes(100) });
  assert.notEqual(first, second);
  assert.ok(revoked.includes(first), "清缓存时旧 URL 已 revoke");
}

// --- 6. 空字节视为失败（不要给 img 一个空 Blob）------------------------------
{
  clearImageCache();
  await assert.rejects(
    () => loadImageUrl("empty.jpg", "image/jpeg", { request: async () => bytes(0) }),
    /图片字节为空/,
  );
  assert.equal(peekImageUrl("empty.jpg"), null, "失败不留下缓存条目");
}

console.log("pwa image cache checks passed");
