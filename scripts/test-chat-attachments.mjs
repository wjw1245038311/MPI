// 桌面端「聊天里的视频附件」：引用解析同源守卫 + chatatt:// 协议的文件解析与 Range。
//
// 背景（2026-09-28）：手机端发来的视频落盘在 %TEMP%/mpi-clipboard，pi 历史里只留一条
// `<file … attach="video" … />` 引用。桌面端要内联播放，就必须：
//   1. 渲染层能把引用从文本里剥出来（否则用户看到一整行原始标签）；
//   2. 主进程能按文件名安全地把它递给 <video>，且支持 Range（拖进度条）。
// 这里钉死三件事：两侧解析规则不能漂移、文件名白名单挡得住路径穿越、Range 解析正确。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

// 沙盒：把 app.getPath("temp") 指到一个临时目录，里面放一个假的视频附件。
const TEMP = join(tmpdir(), `mpi-chat-att-${process.pid}`);
process.env.MPI_TEST_TEMP = TEMP;
mkdirSync(join(TEMP, "mpi-clipboard"), { recursive: true });
const VIDEO_NAME = "ef8e2332-954c-44ff-82bc-a4234c65923c-video-1790606293289-0.mp4";
writeFileSync(join(TEMP, "mpi-clipboard", VIDEO_NAME), Buffer.alloc(4096, 7));

const rendererSide = await import("../src/renderer/src/lib/chat-attachments.ts");
const hostSide = await import("../src/main/remote/video-refs.ts");
const protocolSide = await import("../src/main/chat-attachment-protocol.ts");

const envelope = (name, path) => `<file name="${name}" path="${path}" attach="video" note="video attachment; inline-playable in MPI clients" />`;

// --- 1. 两侧解析规则必须同源（跨文件漂移守卫）----------------------------------

const samples = [
  "普通消息，没有任何引用",
  `看这个${envelope(VIDEO_NAME, `C:\\Users\\x\\AppData\\Local\\Temp\\mpi-clipboard\\${VIDEO_NAME}`)}`,
  `<file name="a.pdf" path="/p/a.pdf" note="attached (binary or large; not inlined)" />`,
  `文件<file name="a.pdf" path="/p/a.pdf" note="attached (binary or large; not inlined)" />${envelope("v1.mp4", "/t/v1.mp4")}`,
  `两个${envelope("a.mp4", "/t/a.mp4")}${envelope("b.mp4", "/t/b.mp4")}`,
];

for (const sample of samples) {
  const renderer = rendererSide.splitVideoRefs(sample);
  const host = hostSide.splitVideoRefs(sample);
  assert.deepEqual(renderer.refs, host.refs, `渲染层与主机侧的引用解析必须一致：${sample.slice(0, 40)}`);
  assert.equal(renderer.text, host.text, `清理后的文本也必须一致：${sample.slice(0, 40)}`);
}

{
  const split = rendererSide.splitVideoRefs(samples[1]);
  assert.deepEqual(split.refs, [{ name: VIDEO_NAME, path: `C:\\Users\\x\\AppData\\Local\\Temp\\mpi-clipboard\\${VIDEO_NAME}` }], "能解出文件名与路径");
  assert.equal(split.text, "看这个", "引用被剥掉且文本已 trim（否则气泡里会多出空行）");
  const mixed = rendererSide.splitVideoRefs(samples[3]);
  assert.ok(mixed.text.includes("a.pdf"), "普通文件引用不能被误剥（保持既有行为）");
  assert.equal(mixed.refs.length, 1);
  assert.deepEqual(rendererSide.splitVideoRefs(samples[0]), { text: samples[0], refs: [] }, "没有标记的文本原样返回（不影响普通消息）");
}

// --- 2. chatatt:// URL + 文件名白名单 ------------------------------------------

{
  const url = rendererSide.chatAttachmentUrl(VIDEO_NAME);
  assert.ok(url.startsWith("chatatt://attachment/?name="), "URL 形状固定（名字走 query，避免 hostname 被小写化）");
  assert.ok(url.includes(encodeURIComponent(VIDEO_NAME)), "文件名经过编码");

  assert.ok(protocolSide.resolveChatAttachment(VIDEO_NAME), "落在 mpi-clipboard 里的合法文件应能解析");
  assert.equal(protocolSide.resolveChatAttachment("../../secret.txt"), null, "路径穿越必须被挡");
  assert.equal(protocolSide.resolveChatAttachment("..\\..\\secret.txt"), null, "Windows 风格的路径穿越也要挡");
  assert.equal(protocolSide.resolveChatAttachment("C:secret.mp4"), null, "不能接受带盘符的名字（白名单里没有冒号）");
  assert.equal(protocolSide.resolveChatAttachment("nope/missing.mp4"), null, "不接受含分隔符的名字");
  assert.equal(protocolSide.resolveChatAttachment("missing.mp4"), null, "文件不存在 → null（渲染层显示占位卡片）");
}

// --- 3. Range 解析（拖进度条靠它）---------------------------------------------

const SIZE = 4096;
assert.deepEqual(protocolSide.parseRange("bytes=0-99", SIZE), { start: 0, end: 99 }, "普通区间");
assert.deepEqual(protocolSide.parseRange("bytes=100-", SIZE), { start: 100, end: SIZE - 1 }, "开区间到结尾");
assert.deepEqual(protocolSide.parseRange(`bytes=-100`, SIZE), { start: SIZE - 100, end: SIZE - 1 }, "后缀形式取最后 N 字节");
assert.deepEqual(protocolSide.parseRange("bytes=0-999999", SIZE), { start: 0, end: SIZE - 1 }, "超出文件末尾要夹到 size-1");
assert.equal(protocolSide.parseRange("bytes=9999-", SIZE), null, "起始位置越界 → 不可满足");
assert.equal(protocolSide.parseRange("bytes=100-50", SIZE), null, "起止颠倒 → 不可满足");
assert.equal(protocolSide.parseRange(null, SIZE), null, "没带 Range → 走 200 全量");
assert.equal(protocolSide.parseRange("items=0-1", SIZE), null, "非 bytes 单位不认");

rmSync(TEMP, { recursive: true, force: true });
console.log("chat-attachments tests passed");
