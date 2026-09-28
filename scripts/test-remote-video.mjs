// 远程**视频附件**：引用协议 + 不在收缩里被截断 + 预算自洽。
//
// 背景（2026-09-28）：视频要「像图片一样在对话框里直接看」，于是字节内联进快照。
// 这里钉死三件事：
//   1. 引用格式的写入/解析同源（videoRefEnvelope ↔ splitVideoRefs），普通 <file> 引用不受影响；
//   2. 收缩器**不能**去砍 image/video 的 base64（砍半 + 追中文标记 = 客户端只能渲染破图/破播放器）；
//   3. 客户端上限、主机校验、快照预算各处不能各说各话（跨文件漂移守卫）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "node:module";

// 源码用 bundler 风格的无后缀相对 import（history-limit.ts 现在也 import 了 ./video-refs）——
// node 下需要一个把它们补成 .ts 的解析器。
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const {
  REMOTE_VIDEO_MAX_BYTES,
  REMOTE_VIDEO_UPLOAD_MAX_BYTES,
  VIDEO_POSTER_BASE64_BUDGET,
  VIDEO_POSTER_MAX_BYTES,
  splitVideoRefs,
  videoMimeForPath,
  videoRefEnvelope,
} = await import("../src/main/remote/video-refs.ts");

const { SHRINK_MARKER, REMOTE_HISTORY_BYTE_BUDGET, prepareRemoteHistory, shrinkToBudget } = await import(
  "../src/main/remote/history-limit.ts"
);

const ROOT = resolve(import.meta.dirname, "..");

// --- 1. 引用协议 -------------------------------------------------------------

{
  const plain = "看下这段 <file name=\"a.txt\" path=\"/p/a.txt\" note=\"attached (binary or large; not inlined)\" /> 日志";
  assert.deepEqual(splitVideoRefs(plain), { text: plain, refs: [] }, "无标记时原样返回（普通 <file> 引用不受影响）");

  const envelope = videoRefEnvelope("video-1.mp4", "/tmp/x/video-1.mp4");
  const split = splitVideoRefs(`看看这个${envelope}`);
  assert.equal(split.text, "看看这个", "引用被剥掉且文本已 trim");
  assert.deepEqual(split.refs, [{ name: "video-1.mp4", path: "/tmp/x/video-1.mp4" }], "引用能原样解回来（写入/解析同源）");

  // 混合：普通文件引用必须留下，视频引用必须剥走。
  const mixed = `先看文件 <file name="a.pdf" path="/p/a.pdf" note="attached (binary or large; not inlined)" />${videoRefEnvelope("v.webm", "/tmp/v.webm")}`;
  const mixedSplit = splitVideoRefs(mixed);
  assert.equal(mixedSplit.refs.length, 1);
  assert.ok(mixedSplit.text.includes("a.pdf"), "普通文件引用不能被误剥");
  assert.ok(!mixedSplit.text.includes("v.webm"), "视频引用必须剥走（否则气泡里会露出引用原文）");

  // 多个视频：都要拿出来，顺序保持一致（预算按“最新优先”分配依赖这个顺序）。
  const two = splitVideoRefs(`${videoRefEnvelope("a.mp4", "/tmp/a.mp4")}${videoRefEnvelope("b.mp4", "/tmp/b.mp4")}`);
  assert.deepEqual(two.refs.map((r) => r.name), ["a.mp4", "b.mp4"]);

  // 封面（poster 属性）能原样往返；没有 poster 的老信封仍照旧解析。
  const withPoster = splitVideoRefs(`看${videoRefEnvelope("v.mp4", "/tmp/v.mp4", "v.mp4.poster.jpg")}`);
  assert.deepEqual(
    withPoster.refs,
    [{ name: "v.mp4", path: "/tmp/v.mp4", poster: "v.mp4.poster.jpg" }],
    "带封面的信封要能解出 poster（快照据此去读封面文件）",
  );
  const noPoster = splitVideoRefs(videoRefEnvelope("v.mp4", "/tmp/v.mp4"));
  assert.equal(noPoster.refs[0].poster, undefined, "旧信封没有 poster 属性，不能凭空造一个");
  assert.equal(noPoster.text, "", "带 note 的信封仍要整条剥走（poster 子句是可选的，不能把后面的属性吞掉）");

  // 名字里带引号不能破坏解析（attr 转义）。
  const quoted = splitVideoRefs(videoRefEnvelope('he"llo.mp4', "/tmp/q.mp4"));
  assert.equal(quoted.refs[0].name, "he&quot;llo.mp4", "引号被转义后解析不破（与 <file> 信封同一规则）");

  assert.equal(videoMimeForPath("/tmp/a.mp4"), "video/mp4");
  assert.equal(videoMimeForPath("/tmp/a.WEBM"), "video/webm");
  assert.equal(videoMimeForPath("/tmp/a.mov"), "video/quicktime");
  assert.equal(videoMimeForPath("/tmp/a.unknown"), "video/mp4", "未知扩展名兜底 mp4（浏览器至少会试着解）");
}

// --- 2. 收缩器不能破坏媒体本体 ------------------------------------------------

{
  const videoData = "V".repeat(600_000);
  const imageData = "I".repeat(400_000);
  const posterData = "P".repeat(200_000);
  const messages = [
    {
      id: "m1",
      role: "user",
      text: "x".repeat(500_000),
      blocks: [
        { type: "text", text: "y".repeat(400_000) },
        { type: "video", name: "a.mp4", mimeType: "video/mp4", data: videoData, size: 450_000, poster: posterData, posterMimeType: "image/jpeg" },
        { type: "image", mimeType: "image/png", data: imageData },
      ],
    },
  ];
  // maxPasses 收小：本用例只验证「该动谁」，不需要跑到收敛（否则每次 pass 都要 stringify 大对象）。
  const limited = shrinkToBudget(messages, 500_000, 5);
  const blocks = limited[0].blocks;
  assert.equal(blocks[1].data, videoData, "视频 base64 必须原封不动（砍半+加标记会让播放器直接坏掉）");
  assert.equal(blocks[1].poster, posterData, "封面（poster）同理：砍半就是一张破图，比没封面还糟");
  assert.equal(blocks[2].data, imageData, "图片 base64 同理（同一个隐患）");
  assert.ok(limited[0].text.includes(SHRINK_MARKER), "该让位的是文本——它才是可收缩的");
  assert.ok(blocks[0].text.includes(SHRINK_MARKER), "文本块可以被收缩");
}

// --- 3. 视频进快照预算：宁可丢更早的消息，也不砍视频本体 ------------------------

{
  const posterData = "P".repeat(220_000); // ≈160KB 原始字节的封面
  const filler = { id: "old", role: "assistant", text: "z".repeat(6_000_000) };
  const withVideo = {
    id: "new",
    role: "user",
    text: "看这个视频",
    blocks: [{ type: "video", name: "v.mp4", mimeType: "video/mp4", poster: posterData, posterMimeType: "image/jpeg", size: 50_000_000 }],
  };
  const out = prepareRemoteHistory([filler, withVideo]);
  const kept = out.find((m) => m.id === "new");
  assert.ok(kept, "带视频的最新消息必须留下");
  assert.equal(kept.blocks[0].poster, posterData, "留下来的封面必须完整");
  assert.ok(!out.some((m) => m.id === "old"), "挤不下时丢的是更早的普通消息");
}

// --- 4. 四处常量一致性（跨文件漂移守卫）---------------------------------------

{
  const serviceSrc = readFileSync(resolve(ROOT, "src", "main", "remote", "service.ts"), "utf8");
  const hostMax = Number(/MAX_REMOTE_VIDEO_DATA = ([\d_]+)/.exec(serviceSrc)?.[1]?.replace(/_/g, ""));
  assert.ok(hostMax > 0, "service.ts 里应有 MAX_REMOTE_VIDEO_DATA");
  const expectedBase64 = Math.ceil((REMOTE_VIDEO_UPLOAD_MAX_BYTES * 4) / 3);
  assert.ok(
    hostMax >= expectedBase64,
    `主机上限 ${hostMax} 必须装得下 ${REMOTE_VIDEO_UPLOAD_MAX_BYTES} 原始字节（base64 ≈ ${expectedBase64}，PWA 选中的视频走 videos 通道整帧上传）`,
  );

  const pwaSrc = readFileSync(resolve(ROOT, "mobile", "pwa", "src", "ThreadView.tsx"), "utf8");
  const pwaMax = Number(/MAX_VIDEO_BYTES = ([\d_]+)/.exec(pwaSrc)?.[1]?.replace(/_/g, ""));
  assert.equal(pwaMax, REMOTE_VIDEO_UPLOAD_MAX_BYTES, "PWA 的视频上限必须等于主机侧的**上传**上限（它走 videos 通道整帧上传）");

  assert.ok(
    VIDEO_POSTER_BASE64_BUDGET < REMOTE_HISTORY_BYTE_BUDGET,
    "封面预算必须小于快照总预算（否则等于没有预算）",
  );
  assert.ok(
    VIDEO_POSTER_MAX_BYTES * 4 < VIDEO_POSTER_BASE64_BUDGET,
    "封面总预算至少要装得下几张封面（否则历史里的封面会成片丢失）",
  );

  // 2026-09-29（阶段2）：快照只下发封面，视频本体一律按需拉。
  // 拆开才成立的两个前提：① 大视频仍有名字可拉（客户端 attachment.fetch）；
  // ② 附件区总量上限装得下至少一个最大的视频（否则刚落盘就被自己的清理策略盯上）。
  assert.ok(
    REMOTE_VIDEO_MAX_BYTES > REMOTE_VIDEO_UPLOAD_MAX_BYTES,
    "可存的视频上限必须大于上传上限（否则拆分无意义）",
  );

  // 封面尺寸/字节上限三端必须一致：主机落盘后由三端渲染，任一端漂移都会出现
  // “封面被主机静默丢弃”或“三端封面清晰度不一致”。
  const pwaPosterSrc = readFileSync(resolve(ROOT, "mobile", "pwa", "src", "lib", "video-attach.ts"), "utf8");
  const desktopPosterSrc = readFileSync(resolve(ROOT, "src", "renderer", "src", "lib", "video-poster.ts"), "utf8");
  const androidPosterSrc = readFileSync(
    resolve(ROOT, "mobile", "app", "app", "src", "main", "java", "com", "mpi", "app", "data", "Attachments.kt"),
    "utf8",
  );
  for (const [label, source] of [["PWA", pwaPosterSrc], ["桌面端", desktopPosterSrc], ["安卓", androidPosterSrc]]) {
    const maxBytes = Number(/POSTER_MAX_BYTES = ([\d_]+)/.exec(source)?.[1]?.replace(/_/g, ""));
    const maxEdge = Number(/POSTER_MAX_EDGE = ([\d_]+)/.exec(source)?.[1]?.replace(/_/g, ""));
    assert.equal(maxBytes, VIDEO_POSTER_MAX_BYTES, `${label}的封面字节上限必须与主机侧 VIDEO_POSTER_MAX_BYTES 一致`);
    assert.equal(maxEdge, 640, `${label}的封面最长边应为 640px（三端口径一致）`);
  }
  // 主机侧的接收上限要装得下三端生成的上限（base64 膨胀 + 余量）。
  const posterHostMax = Number(/MAX_REMOTE_POSTER_DATA = ([\d_]+)/.exec(serviceSrc)?.[1]?.replace(/_/g, ""));
  assert.ok(
    posterHostMax >= Math.ceil((VIDEO_POSTER_MAX_BYTES * 4) / 3),
    `service.ts 的 MAX_REMOTE_POSTER_DATA(${posterHostMax}) 必须装得下 ${VIDEO_POSTER_MAX_BYTES} 原始字节的封面`,
  );
  const storeSrc = readFileSync(resolve(ROOT, "src", "main", "chat-attachment-store.ts"), "utf8");
  const dirMaxExpression = /const MAX_DIR_BYTES = ([\d_\s*]+);/.exec(storeSrc)?.[1];
  const dirMaxBytes = (dirMaxExpression || "")
    .split("*")
    .reduce((acc, part) => acc * Number(part.replace(/[\s_]/g, "") || NaN), 1);
  assert.ok(
    Number.isFinite(dirMaxBytes) && dirMaxBytes >= REMOTE_VIDEO_MAX_BYTES * 4,
    `附件区总量（${dirMaxExpression?.trim() ?? "读不到"}）至少要装得下 4 个最大视频（${REMOTE_VIDEO_MAX_BYTES}），否则等于没放宽`,
  );
}

// --- 5. 视频字节不能把历史挤掉（2026-09-28 真机回归）--------------------------------
{
  // 复现真机：70 条小消息 + 一条 2MB 视频（base64 ≈2.8MB）。
  const filler = Array.from({ length: 70 }, (_, index) => ({
    id: `t${index}`,
    role: "assistant",
    text: "正文".repeat(500),
  }));
  const posterData = "P".repeat(220_000);
  const withVideo = {
    id: "v",
    role: "user",
    blocks: [{ type: "video", name: "clip.mp4", mimeType: "video/mp4", poster: posterData, posterMimeType: "image/jpeg", size: 50_000_000 }],
  };
  const out = prepareRemoteHistory([...filler, withVideo]);
  // 修复前：视频字节吃掉 2MB 快照预算 → 裁剪从最旧的开始丢，一次丢几十条历史（真机 rendered=71 sent=4）。
  assert.ok(
    out.length > 50,
    `带视频时不能把历史裁光（实际只剩 ${out.length}/${filler.length + 1} 条）`,
  );
  const keptVideo = out.find((m) => m.id === "v");
  assert.equal(keptVideo?.blocks?.[0]?.poster, posterData, "封面要完整保留");
  assert.equal(keptVideo?.blocks?.[0]?.data, undefined, "快照**不能**再带视频本体（那是几 MB 级字节）");
  // 但媒体预算不是无底洞：整体仍须远低于客户端硬上限。
  assert.ok(
    JSON.stringify(out).length < REMOTE_HISTORY_BYTE_BUDGET,
    "含视频的快照仍要进得了客户端硬上限",
  );
}

console.log("remote-video tests passed");
