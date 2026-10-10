/**
 * 拖拽 / 粘贴附件分通道测试（2026-10-10）：routeDroppedFiles 纯函数。
 *
 *   1. MIME 分类——image/* → images、video/* → videos、其余（含空 type）→ files
 *   2. 大小写不敏感 + 混合输入各通道内保序
 *   3. 空列表 / null 条目防御
 */
import assert from "node:assert/strict";

const { routeDroppedFiles } = await import("../mobile/pwa/src/lib/attach-route.ts");

// node 环境没有真实 File；函数只读 .type，用最小对象代替。
const mk = (name, type) => ({ name, type });

// ---- 1. MIME 分类 -----------------------------------------------------------
{
  const routed = routeDroppedFiles([
    mk("shot.png", "image/png"),
    mk("clip.mp4", "video/mp4"),
    mk("report.pdf", "application/pdf"),
    mk("notes.txt", "text/plain"),
    mk("archive.zip", ""), // 浏览器给不出 type 的常见文件 → files 通道原样上传
  ]);
  assert.deepEqual(routed.images.map((f) => f.name), ["shot.png"], "image/* → images");
  assert.deepEqual(routed.videos.map((f) => f.name), ["clip.mp4"], "video/* → videos");
  assert.deepEqual(
    routed.files.map((f) => f.name),
    ["report.pdf", "notes.txt", "archive.zip"],
    "其余（含空 type）→ files，且保序",
  );
}

// ---- 2. 大小写不敏感 + 多文件混合 -------------------------------------------
{
  const routed = routeDroppedFiles([
    mk("a.PNG", "IMAGE/PNG"),
    mk("b.MOV", "Video/QuickTime"),
    mk("c.jpg", "image/jpeg"),
    mk("d.mkv", "video/x-matroska"),
    mk("e.log", ""),
  ]);
  assert.deepEqual(routed.images.map((f) => f.name), ["a.PNG", "c.jpg"], "大写 MIME 也识别，通道内保序");
  assert.deepEqual(routed.videos.map((f) => f.name), ["b.MOV", "d.mkv"]);
  assert.deepEqual(routed.files.map((f) => f.name), ["e.log"]);
}

// ---- 3. 空列表 / null 条目防御 ----------------------------------------------
{
  const empty = routeDroppedFiles([]);
  assert.deepEqual(empty, { images: [], videos: [], files: [] }, "空输入 → 三个通道全空");
  const withNull = routeDroppedFiles([null, mk("x.png", "image/png"), undefined]);
  assert.equal(withNull.images.length, 1, "null/undefined 条目被跳过，不抛错");
}

console.log("pwa drop-attach tests passed");
