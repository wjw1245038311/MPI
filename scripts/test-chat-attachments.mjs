// 桌面端「聊天里的视频附件」：引用解析同源守卫 + chatatt:// 协议的文件解析与 Range。
//
// 背景（2026-09-28）：手机端发来的视频落盘在 %TEMP%/mpi-clipboard，pi 历史里只留一条
// `<file … attach="video" … />` 引用。桌面端要内联播放，就必须：
//   1. 渲染层能把引用从文本里剥出来（否则用户看到一整行原始标签）；
//   2. 主进程能按文件名安全地把它递给 <video>，且支持 Range（拖进度条）。
// 这里钉死三件事：两侧解析规则不能漂移、文件名白名单挡得住路径穿越、Range 解析正确。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

// 沙盒：把 app.getPath("userData")/"temp" 都指到临时目录。
// ⚠️ temp 必须隔离：resolve 会回退到 `%TEMP%/mpi-clipboard` 看旧附件，
// 不隔离就会去读真实机器上的目录（测试不再 hermetic）。
const TEMP = join(tmpdir(), `mpi-chat-att-${process.pid}`);
const SANDBOX_TEMP = join(TEMP, "sys-temp");
process.env.MPI_TEST_USER_DATA = TEMP;
process.env.MPI_TEST_TEMP = SANDBOX_TEMP;
mkdirSync(join(TEMP, "mpi-clipboard"), { recursive: true });
mkdirSync(join(SANDBOX_TEMP, "mpi-clipboard"), { recursive: true });
const VIDEO_NAME = "ef8e2332-954c-44ff-82bc-a4234c65923c-video-1790606293289-0.mp4";

const rendererSide = await import("../src/renderer/src/lib/chat-attachments.ts");
// 渲染层真正的引用解析在 store.ts 的 parseUserMessage（那里本来就在做 <file> 信封 → 附件）。
const { parseUserMessage } = await import("../src/renderer/src/store.ts");
const hostSide = await import("../src/main/remote/video-refs.ts");
const protocolSide = await import("../src/main/chat-attachment-protocol.ts");
const storeSide = await import("../src/main/chat-attachment-store.ts");

// 落盘一个假视频（走真实函数，顺带验证落盘本身）。
const POSTER_B64 = Buffer.alloc(1024, 5).toString("base64");
const staged = storeSide.stageChatVideoBytes({
  mimeType: "video/mp4",
  data: Buffer.alloc(4096, 7).toString("base64"),
  poster: { data: POSTER_B64, mimeType: "image/jpeg" },
});
assert.equal(staged.size, 4096, "手机端视频应落在持久附件区（按字节写入）");
const durableName = staged.name;
// 封面：与视频同目录、名字由视频名派生，能被 resolve 出来（快照回填就靠它）。
assert.ok(staged.posterName, "带封面的上传应该把封面一并落盘");
assert.equal(staged.posterName, hostSide.posterNameFor(durableName, "image/jpeg"), "封面文件名必须由视频名派生（快照靠 `poster=` 属性找它）");

{
  const resolved = storeSide.resolveChatAttachment(staged.posterName);
  assert.ok(resolved, "封面必须能被 resolveChatAttachment 解析到（否则快照里永远是深色卡片）");
  const slice = storeSide.readAttachmentSlice(staged.posterName, 0);
  assert.equal(slice.size, 1024, "封面字节数应与写入时一致");
  assert.ok(slice.data.equals(Buffer.alloc(1024, 5)), "封面字节必须原样落盘（不是被压过/截过的）");

  // 信封往返：poster 名写进去、解析得回来（写入/解析同源）。
  const envelopeText = hostSide.videoRefEnvelope(durableName, resolved, staged.posterName);
  const parsedRef = hostSide.splitVideoRefs(`看这个${envelopeText}`);
  assert.equal(parsedRef.text, "看这个", "带封面的引用也要从可见文本里剔掉");
  assert.deepEqual(
    { name: parsedRef.refs[0].name, thumb: parsedRef.refs[0].thumb },
    { name: durableName, thumb: staged.posterName },
    "封面属性必须原样往返（内部字段统一叫 thumb；wire 上视频仍写 poster）",
  );

  // 超大封面必须被丢掉（不能让它变成新的“大字节”），但视频本身照常落盘。
  const fat = storeSide.stageChatVideoBytes({
    mimeType: "video/mp4",
    data: Buffer.alloc(16, 1).toString("base64"),
    poster: { data: Buffer.alloc(hostSide.VIDEO_POSTER_MAX_BYTES + 1, 1).toString("base64"), mimeType: "image/jpeg" },
  });
  assert.equal(fat.posterName, null, "超出上限的封面应被丢弃（视频本身不受影响）");
  assert.ok(storeSide.resolveChatAttachment(fat.name), "封面被丢弃时视频必须照常落盘");

  // 不支持的封面类型也要被丢掉（协议只收 jpeg/png/webp，而落盘侧不依赖调用方自律）。
  const bmp = storeSide.stageChatVideoBytes({
    mimeType: "video/mp4",
    data: Buffer.alloc(16, 2).toString("base64"),
    poster: { data: Buffer.alloc(64, 2).toString("base64"), mimeType: "image/bmp" },
  });
  assert.equal(bmp.posterName, null, "不支持的封面 MIME 应被丢弃");
}
// 旧名字（%TEMP%/mpi-clipboard 时代）现在应该解析不到——旧附件退化为占位卡片是预期行为。
const LEGACY_NAME = VIDEO_NAME;

const envelope = (name, path) => `<file name="${name}" path="${path}" attach="video" note="video attachment; inline-playable in MPI clients" />`;

// --- 1. 主机写信封 → 渲染层解成「视频附件」（跨文件契约守卫）-----------------------
// 用**真实产出函数**（hostSide.videoRefEnvelope）当下游解析的输入：两边一旦漂移，
// 症状就是“气泡里冒出原始标签”或“视频被当成普通文件卡片”。
{
  const abs = `C:\\Users\\x\\AppData\\Roaming\\MPI Dev\\${storeSide.CHAT_ATTACHMENT_DIR}\\${durableName}`;
  const parsed = parseUserMessage(`看这个${hostSide.videoRefEnvelope(durableName, abs)}`);
  assert.equal(parsed.text, "看这个", "信封要从可见文本里剔掉（否则气泡里多一行原始标签）");
  assert.equal(parsed.attachments.length, 1);
  assert.deepEqual(
    { kind: parsed.attachments[0].kind, name: parsed.attachments[0].name, path: parsed.attachments[0].path },
    { kind: "video", name: durableName, path: abs },
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
  const url = rendererSide.chatAttachmentUrl(durableName);
  assert.ok(url.startsWith("chatatt://attachment/?name="), "URL 形状固定（名字走 query，避免 hostname 被小写化）");
  assert.ok(url.includes(encodeURIComponent(durableName)), "文件名经过编码");

  assert.ok(storeSide.resolveChatAttachment(durableName), "落在持久附件区里的合法文件应能解析");
  assert.equal(storeSide.resolveChatAttachment("../../secret.txt"), null, "路径穿越必须被挡");
  assert.equal(storeSide.resolveChatAttachment("..\\..\\secret.txt"), null, "Windows 风格的路径穿越也要挡");
  assert.equal(storeSide.resolveChatAttachment("C:secret.mp4"), null, "不能接受带盘符的名字（白名单里没有冒号）");
  assert.equal(storeSide.resolveChatAttachment("nope/missing.mp4"), null, "不接受含分隔符的名字");
  assert.equal(storeSide.resolveChatAttachment("missing.mp4"), null, "文件不存在 → null（渲染层显示占位卡片）");
  assert.equal(storeSide.resolveChatAttachment(LEGACY_NAME), null, "旧 %TEMP% 时代、而那里也没有该文件 → null");
  // 旧目录兜底：历史消息的信封指向 %TEMP%/mpi-clipboard，文件还在那儿时仍要能播。
  writeFileSync(join(SANDBOX_TEMP, "mpi-clipboard", LEGACY_NAME), Buffer.alloc(64, 3));
  assert.ok(storeSide.resolveChatAttachment(LEGACY_NAME), "旧目录里存在的附件要能解析（否则老消息全变占位卡片）");
  // 桌面端本地视频：adopt 复制进持久区（原文件不动），超过上限则不收。
  const localVideo = join(TEMP, "local-clip.mp4");
  writeFileSync(localVideo, Buffer.alloc(1024, 1));
  const adopted = storeSide.adoptChatVideo(localVideo);
  assert.ok(adopted && storeSide.resolveChatAttachment(adopted.name), "桌面端视频应被复制进持久附件区");
  assert.ok(existsSync(localVideo), "复制不能让原文件消失");
  assert.equal(storeSide.adoptChatVideo(join(TEMP, "nope.mp4")), null, "文件不存在 → null（退回普通文件引用）");
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

// --- 4. P2：别名 / 存量合并 / 引用感知 GC --------------------------------------
// 这三件事都是「动真实数据」的，所以把三条安全边界钉死：
//   ① 合并前后的老名字必须照旧解析（历史消息永不重写）；
//   ② 只有「同一内容的块序置换」才允许合并（否则拒绝）；
//   ③ GC 不碰任何被会话引用的附件。
const { createHash, randomUUID } = await import("node:crypto");
const CH = 4 * 1024 * 1024;
const content = Buffer.alloc(CH * 2 + 512);
for (let i = 0; i < content.length; i += 1) content[i] = (i * 13) % 251;
// 正确顺序的副本 + 一份「块序错位」的副本（各 4MB 块相同、顺序不同——就是 2026-09-29 事故的形态）。
// ⚠️ 置换必须**按 4MB 块对齐**：把尾块移走会改变后续块的边界，那就不是同一个多重集了。
const keepBytes = content;
const scrambled = Buffer.concat([
  content.subarray(CH, CH * 2),
  content.subarray(0, CH),
  content.subarray(CH * 2),
]);
const keepEntry = storeSide.storeObject({ bytes: keepBytes, label: "keep.mp4", mime: "video/mp4" });
const dupLegacyName = `${randomUUID()}-dup.mp4`;
writeFileSync(join(TEMP, "chat-attachments", dupLegacyName), scrambled);
assert.ok(keepEntry, "保留副本应能落盘");
const mergeDry = storeSide.mergeDuplicateAttachments(keepEntry.name, [dupLegacyName]);
assert.equal(mergeDry.ok, true, `块序置换应允许合并（实际：${mergeDry.reason}）`);
const unrelatedName = `${randomUUID()}-other.mp4`;
writeFileSync(join(TEMP, "chat-attachments", unrelatedName), Buffer.alloc(content.length, 3));
assert.equal(
  storeSide.mergeDuplicateAttachments(keepEntry.name, [unrelatedName]).ok,
  false,
  "内容不同的两份绝不能合并（宁可浪费空间，也不能把两份不同内容错当一份）",
);
const mergeApplied = storeSide.mergeDuplicateAttachments(keepEntry.name, [dupLegacyName], { apply: true });
assert.equal(mergeApplied.ok, true, "合并应成功");
assert.ok(mergeApplied.reclaimedBytes >= scrambled.length, "应回收副本的字节");
assert.ok(!existsSync(join(TEMP, "chat-attachments", dupLegacyName)), "副本物理文件应已删除");
assert.ok(
  storeSide.resolveChatAttachment(dupLegacyName)?.endsWith(`${mergeApplied.key}.mp4`),
  "老名字（副本名）必须仍能解析到对象——历史消息不动也能继续播",
);
assert.equal(storeSide.aliasFor(dupLegacyName), mergeApplied.key, "别名表应有这条映射");

// GC：被引用的不动，没人引用的才清；超上限时给出报告而不是静默删
const orphan = storeSide.storeObject({ bytes: Buffer.alloc(2048, 9), label: "orphan.mp4", mime: "video/mp4" });
assert.ok(orphan);
const gcReport = await storeSide.pruneChatAttachments(1024 * 1024, {
  collectReferenced: async () => new Set([keepEntry.name]),
});
assert.equal(gcReport.liveSetAvailable, true, "引用集合可用");
assert.ok(storeSide.hasObject(keepEntry.name), "被引用的对象必须留下");
assert.ok(!storeSide.hasObject(orphan.name), "无人引用的对象应被回收");
const gcNoLiveSet = await storeSide.pruneChatAttachments(1, { collectReferenced: async () => null });
assert.equal(gcNoLiveSet.liveSetAvailable, false, "引用集合拿不到要如实上报");
assert.equal(gcNoLiveSet.removed.length, 0, "拿不到引用集合时**一个都不删**（宁可不腾空间）");
assert.equal(gcNoLiveSet.overCapacity, true, "超上限要报出来，交给用户处理");
console.log("ok - P2：别名解析 / 块序置换合并（含拒绝异内容）/ 引用感知 GC");

// --- 5. P3：媒体类型（图/音/文件）不再是只认视频 ---------------------------------
{
  const { mediaRefEnvelope, splitMediaRefs, mediaKindForMime, mediaExtForMime } = hostSide;
  assert.equal(mediaKindForMime("image/png"), "image");
  assert.equal(mediaKindForMime("audio/mpeg"), "audio");
  assert.equal(mediaKindForMime("video/mp4"), "video");
  assert.equal(mediaKindForMime("application/pdf"), "file", "认不出的 mime 归到普通文件");
  assert.equal(mediaKindForMime(undefined, "photo.JPG"), "image", "mime 缺失时按扩展名推（大小写不敏感）");
  assert.equal(mediaExtForMime("image/png"), ".png");
  assert.equal(mediaExtForMime(undefined, "报表.xlsx"), ".xlsx", "不认识的 mime 用原名后缀（不穷举）");
  assert.equal(mediaExtForMime(undefined, undefined), ".bin", "什么都没有就 .bin（不猜）");

  // 媒体引用往返：kind/thumb/key/label 都要能解回来
  const imgKey = "c".repeat(64);
  const envelope = mediaRefEnvelope({
    name: imgKey,
    abs: "/tmp/x.png",
    kind: "image",
    key: `sha256:${imgKey}`,
    label: "照片.png",
    thumb: `${imgKey}.thumb.jpg`,
    size: 1234,
  });
  const parsed = splitMediaRefs(`看图${envelope}`);
  assert.equal(parsed.text, "看图", "媒体引用也要从可见文本里剔掉");
  assert.deepEqual(
    parsed.refs,
    [{ name: imgKey, path: "/tmp/x.png", kind: "image", thumb: `${imgKey}.thumb.jpg`, key: `sha256:${imgKey}`, label: "照片.png" }],
    "媒体引用原样往返",
  );
  // 老视频引用（attach="video" + poster）仍然解成 kind=video，且缩略图映射到 thumb
  const legacyVideo = splitMediaRefs(hostSide.videoRefEnvelope("v.mp4", "/tmp/v.mp4", "v.mp4.poster.jpg"));
  assert.equal(legacyVideo.refs[0].kind, "video", "老格式必须仍被认作视频");
  assert.equal(legacyVideo.refs[0].thumb, "v.mp4.poster.jpg", "poster 属性映射到统一字段 thumb");
  // 普通 <file> 引用不受影响（它们是给 agent 的输入文件）
  assert.equal(splitMediaRefs("<file name=\"a.txt\" path=\"/p/a.txt\" note=\"x\" />").refs.length, 0);

  // 图片对象按自己的扩展名落盘（不能都写成 .mp4）
  const image = storeSide.storeObject({ bytes: Buffer.alloc(512, 4), label: "p.png", mime: "image/png" });
  assert.ok(image, "图片也应能入对象库");
  assert.ok(storeSide.resolveChatAttachment(image.name)?.endsWith(".png"), "对象的扩展名要跟着 mime 走");
  assert.equal(storeSide.objectMeta(image.name)?.label, "p.png", "可读名要存下来（key 本身没有人看得懂）");
  const audio = storeSide.storeObject({ bytes: Buffer.alloc(256, 2), label: "voice.m4a", mime: "audio/mp4" });
  assert.ok(storeSide.resolveChatAttachment(audio.name)?.endsWith(".m4a"), "音频同理");
  const thumb = storeSide.storeThumbnail(image.name, { data: Buffer.alloc(64, 1).toString("base64"), mimeType: "image/jpeg" });
  assert.equal(thumb, `${image.name}.thumb.jpg`, "缩略图命名 `<key>.thumb.<ext>`");
  assert.ok(storeSide.resolveChatAttachment(thumb), "缩略图要能按名字解析（客户端要拉它）");
  assert.ok(storeSide.findVideoPoster(image.name), "统一的缩略图查找要能同时认新名与老 poster 名");
  console.log("ok - P3：媒体大类推定 / media 引用往返（含 thumb）/ 图与音对象按 mime 落盘");
}

rmSync(TEMP, { recursive: true, force: true });
console.log("chat-attachments tests passed");
