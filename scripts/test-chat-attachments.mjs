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
// 渲染层真正的引用解析在 store.ts 的 parseUserMessage（那里本来就在做 <file> 信封 → 附件）。
const { parseUserMessage } = await import("../src/renderer/src/store.ts");
const hostSide = await import("../src/main/remote/video-refs.ts");
const protocolSide = await import("../src/main/chat-attachment-protocol.ts");

const envelope = (name, path) => `<file name="${name}" path="${path}" attach="video" note="video attachment; inline-playable in MPI clients" />`;

// --- 1. 主机写信封 → 渲染层解成「视频附件」（跨文件契约守卫）-----------------------
// 用**真实产出函数**（hostSide.videoRefEnvelope）当下游解析的输入：两边一旦漂移，
// 症状就是“气泡里冒出原始标签”或“视频被当成普通文件卡片”。
{
  const abs = `C:\\Users\\x\\AppData\\Local\\Temp\\mpi-clipboard\\${VIDEO_NAME}`;
  const parsed = parseUserMessage(`看这个${hostSide.videoRefEnvelope(VIDEO_NAME, abs)}`);
  assert.equal(parsed.text, "看这个", "信封要从可见文本里剔掉（否则气泡里多一行原始标签）");
  assert.equal(parsed.attachments.length, 1);
  assert.deepEqual(
    { kind: parsed.attachments[0].kind, name: parsed.attachments[0].name, path: parsed.attachments[0].path },
    { kind: "video", name: VIDEO_NAME, path: abs },
    "必须标成 video（否则渲染成文件卡片，得点开才知道是视频）",
  );

  // 普通文件引用不能被误标成视频（保持既有行为）。
  const plain = parseUserMessage('<file name="a.pdf" path="/p/a.pdf" note="attached (binary or large; not inlined)" />');
  assert.equal(plain.attachments[0].kind, undefined, "普通 <file> 引用不能带上 kind=video");

  // 同时带普通文件与视频：各归各的。
  const mixed = parseUserMessage(
    `<file name="a.pdf" path="/p/a.pdf" note="attached (binary or large; not inlined)" />${hostSide.videoRefEnvelope("v.mp4", "/t/v.mp4")}`,
  );
  assert.deepEqual(mixed.attachments.map((a) => a.kind), [undefined, "video"], "混合场景各归各的");
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
