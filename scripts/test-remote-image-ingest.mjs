// 内联图后台落库队列（主机侧）：快照只查表，落库+派生图在后台跑。
//
// 背景（docs/MOBILE-IMAGE-KEY.md §13 A2）：agent 直接吐在 tool result 里的 base64 图
// （ComfyUI 产物）没有内容 key。同步落库要「base64 解码 + sha256 + 缩放」，30 张会把
// 主进程卡 1–2 秒，所以拆成：快照查表（命中就用 key）→ 没命中入队 → 下次快照切新路径。
import assert from "node:assert/strict";

const { ImageIngestQueue, decodeInlineImageData } = await import("../src/main/remote/image-ingest.ts");

const b64 = (n, fill = 65) => Buffer.alloc(n, fill).toString("base64");

// --- 1. 内联图片解码：裸 base64 / data URL / 坏数据 --------------------------
{
  const plain = decodeInlineImageData(b64(16));
  assert.ok(plain && plain.bytes.length === 16, "裸 base64 能解");
  assert.equal(plain.mime, null, "没有前缀就没有 mime");

  const withPrefix = decodeInlineImageData(`data:image/png;base64,${b64(8)}`);
  assert.ok(withPrefix && withPrefix.bytes.length === 8);
  assert.equal(withPrefix.mime, "image/png", "data URL 的 MIME 要解出来");

  assert.equal(decodeInlineImageData(""), null);
  assert.equal(decodeInlineImageData("   "), null);
}

// --- 2. 快照查表与后台落库的基本闭环 ---------------------------------------
{
  const stored = [];
  const queue = new ImageIngestQueue({
    store: ({ bytes }) => {
      stored.push(bytes.length);
      return { key: `key-${stored.length}`, thumbName: `key-${stored.length}.thumb.jpg`, lqipName: null };
    },
  });
  const image = b64(32);
  assert.equal(queue.lookup(image), undefined, "还没落库 → 未命中（快照本轮走老路径）");
  queue.enqueue(image, "image/png");
  await queue.whenIdle();
  assert.equal(stored.length, 1, "后台只处理一次");
  assert.equal(queue.lookup(image), "key-1", "落库后快照能命中 key");
  assert.deepEqual(queue.stats(), { stored: 1, failed: 0, dropped: 0, queued: 0, remembered: 1 });
}

// --- 3. 同一张图重复入队 → 只落库一次（ComfyUI 同一张图会被多次引用）--------
{
  let calls = 0;
  const queue = new ImageIngestQueue({
    store: () => {
      calls += 1;
      return { key: "k", thumbName: null, lqipName: null };
    },
  });
  const image = b64(64);
  queue.enqueue(image);
  queue.enqueue(image);
  queue.enqueue(image);
  await queue.whenIdle();
  assert.equal(calls, 1, "指纹去重：同一张只落一次");
}

// --- 4. 失败不污染表、不进 known（下次快照仍会入队重试）---------------------
{
  let calls = 0;
  const queue = new ImageIngestQueue({
    store: () => {
      calls += 1;
      return null; // 落库失败（格式不支持 / 写盘失败）
    },
  });
  const image = b64(16, 66);
  queue.enqueue(image);
  await queue.whenIdle();
  assert.equal(calls, 1);
  assert.equal(queue.lookup(image), undefined, "失败不写 known");
  assert.equal(queue.stats().failed, 1);
}

// --- 5. 解码失败：不落库、只记 failed --------------------------------------
{
  let calls = 0;
  const queue = new ImageIngestQueue({
    store: () => {
      calls += 1;
      return { key: "k", thumbName: null, lqipName: null };
    },
  });
  // 空串直接不入队；这里用「只有空白字符」的 base64 走到解码分支
  queue.enqueue("   ");
  await queue.whenIdle();
  assert.equal(calls, 0, "解不出字节就不该调 store");
}

// --- 6. 超大图直接放弃（同步 sha256/解码会拖住主进程）----------------------
{
  let calls = 0;
  const queue = new ImageIngestQueue({
    store: () => {
      calls += 1;
      return { key: "k", thumbName: null, lqipName: null };
    },
    maxBase64Chars: 100,
  });
  const huge = b64(200);
  assert.equal(queue.lookup(huge), undefined);
  queue.enqueue(huge);
  await queue.whenIdle();
  assert.equal(calls, 0, "超过上限不入队、不落库");
  assert.equal(queue.stats().dropped, 1);
}

// --- 7. 队列积压上限：丢最旧的，不是无限涨 --------------------------------
{
  const queue = new ImageIngestQueue({
    store: () => null,
    maxQueue: 2,
  });
  for (let i = 0; i < 6; i += 1) queue.enqueue(b64(16, 65 + i));
  const stats = queue.stats();
  assert.ok(stats.queued <= 2, `队列应压在上限内，实际 ${stats.queued}`);
  assert.ok(stats.dropped >= 1, "溢出的计入 dropped");
  await queue.whenIdle();
}

// --- 8. 「记住」表是 LRU：老图被挤掉后，下次快照会重新入队 -----------------
{
  const queue = new ImageIngestQueue({
    store: ({ bytes }) => ({ key: `k${bytes[0]}`, thumbName: null, lqipName: null }),
    maxRemembered: 2,
  });
  const images = [b64(8, 1), b64(8, 2), b64(8, 3)];
  for (const image of images) queue.enqueue(image);
  await queue.whenIdle();
  assert.equal(queue.lookup(images[2]), "k3", "最新的还在");
  assert.equal(queue.lookup(images[0]), undefined, "最旧的已被 LRU 挤掉");
  assert.equal(queue.stats().remembered, 2);
}

console.log("remote image ingest checks passed");
