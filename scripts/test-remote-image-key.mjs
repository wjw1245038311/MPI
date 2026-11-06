// 手机端图片：快照只发元数据，字节按需拉（docs/MOBILE-IMAGE-KEY.md）。
//
// 2026-11-06 现场：会话里图片一多，手机只看到最早 1–3 张，其余图**整块消失且点不开**
// （240KB 图片预算 + 最近 12 条窗口，超了直接 return null —— 连 key 都没带）。
//
// 这个套件钉三件事：
//   1. 新形态的块**一定没有内联字节**，但 key/thumb/尺寸都在；
//   2. 派生名（`<key>.thumb.jpg` 等）的授权只看父名（否则主机重启后拉缩略图全 404）；
//   3. 主机侧两条分支都在：声明了 imageKeys 走元数据，没声明/无 key 仍走老行为
//      （旧客户端不能炸）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "node:module";

// image-block.ts / video-refs.ts 有无后缀 import 与 .ts 路径，node 下需补。
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const { remoteImageMetadataBlock } = await import("../src/main/remote/image-block.ts");
const { derivedAttachmentBase, thumbNameFor, lqipNameFor } = await import("../src/main/remote/video-refs.ts");

const KEY = "a".repeat(64);

// --- 1) 元数据块：没有字节，但信息齐全 ---------------------------------------

{
  const block = remoteImageMetadataBlock({
    key: KEY,
    mimeType: "image/png",
    label: "截图.png",
    thumbName: `${KEY}.thumb.jpg`,
    lqip: "data-lqip-base64",
    bytes: 123456,
    width: 1600,
    height: 900,
  });

  assert.equal(block.type, "image");
  assert.equal(block.key, KEY, "key 必须下发（客户端靠它拉原图）");
  assert.equal(block.omitted, true, "本体未下发必须显式标记");
  assert.equal(block.data, undefined, "新形态不得内联任何图片字节");
  assert.equal(block.thumb, `${KEY}.thumb.jpg`, "缩略图名要带上（省一次探测）");
  assert.equal(block.lqip, "data-lqip-base64");
  assert.equal(block.bytes, 123456);
  assert.equal(block.width, 1600);
  assert.equal(block.height, 900);
  assert.equal(block.mimeType, "image/png");
  assert.equal(block.label, "截图.png");
  // 元数据块必须是「小」的：这是整个方案的体积前提
  assert.ok(JSON.stringify(block).length < 1024, `单块应远小于 1KB，实际 ${JSON.stringify(block).length}`);
}

// --- 2) 字段兜底：坏 MIME / 非法尺寸不外泄 -------------------------------

{
  const block = remoteImageMetadataBlock({
    key: KEY,
    mimeType: "text/html",
    bytes: 0,
    width: -5,
    height: Number.NaN,
  });
  assert.equal(block.mimeType, "image/jpeg", "不认识的 MIME 回落 image/jpeg，不把 text/html 递给图片解码器");
  assert.equal(block.bytes, undefined, "0 字节不算有效大小");
  assert.equal(block.width, undefined, "负数/非法宽高不写字段");
  assert.equal(block.height, undefined);
  assert.equal(block.thumb, undefined, "没有缩略图就不写字段（客户端会退回去拉原图）");
}

// --- 3) 派生名授权：只看父名 ---------------------------------------------

{
  assert.equal(derivedAttachmentBase(thumbNameFor(KEY)), KEY, "缩略图名反推出父 key");
  assert.equal(derivedAttachmentBase(lqipNameFor(KEY)), KEY, "占位图名反推出父 key");
  assert.equal(derivedAttachmentBase(`${KEY}.poster.jpg`), KEY, "视频历史封面名也要认");
  assert.equal(derivedAttachmentBase("photo.jpg"), null, "普通文件名不是派生名");
  assert.equal(derivedAttachmentBase(`${KEY}-screenshot.png`), null, "普通附件不是派生名");
  assert.equal(derivedAttachmentBase(`${KEY}.thumb`), null, "缺扩展名不算派生名");
  assert.equal(derivedAttachmentBase(""), null);
  assert.equal(derivedAttachmentBase(`${"x".repeat(300)}.thumb.jpg`), null, "父名过长直接拒绝（防止拿长名绕过）");
}

// --- 4) 主机侧两条分支都在（源码守卫）------------------------------------
//
// 旧客户端不带 imageKeys → 必须仍然拿内联缩略图；新客户端带了 → 只拿元数据。
// 这条守卫防的是「为了省体积把老分支删了」，那会让现网客户端满屏“图片无法显示”。

{
  const ipc = readFileSync(resolve(import.meta.dirname, "..", "src", "main", "ipc.ts"), "utf8");
  assert.match(ipc, /if \(options\.imageKeys && ref\?\.name && isContentKey\(ref\.name\)\)/, "新路径必须同时要求：客户端声明 + 有内容 key");
  assert.match(ipc, /remoteImageMetadataBlock\(/, "新路径要复用纯函数（不要再抄一份字段拼装）");
  assert.match(ipc, /snapshotImagePayload\(block\.data, thumbnail, imageBudget\)/, "老路径（旧客户端/无 key 的内联图）必须保留");
  // 新路径必须在扣图片预算**之前**返回，否则又会被 240KB 预算拖回老问题
  const newPath = ipc.indexOf("if (options.imageKeys && ref?.name && isContentKey(ref.name))");
  const budget = ipc.indexOf("imageBudget -= decision.data.length");
  assert.ok(newPath > 0 && budget > newPath, "新路径应先于图片预算扣减返回");
}

{
  const service = readFileSync(resolve(import.meta.dirname, "..", "src", "main", "remote", "service.ts"), "utf8");
  const occurrences = service.match(/imageKeys: payload\.imageKeys === true/g) || [];
  assert.equal(occurrences.length, 3, "thread.get / thread.resync / thread.subscribe 三处都要透传 imageKeys");
  assert.match(service, /imageKeys\?: boolean/, "getThread 的 options 类型要声明 imageKeys");
}

console.log("remote image key checks passed");
