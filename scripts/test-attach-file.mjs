// 「agent → 客户端」附件下行（mpi_attach_file）的主机侧行为。
//
// 背景（2026-10-15）：设计文档 §6.4 早就预留了 file 块的按需拉取，但一直没实现——
// `kind="file"` 引用在快照生成处会掉进 video 分支，变成一张点开必失败的「视频卡片」。
// 本功能补上：扩展递交 → 主进程入库 → 回引用文本 → 快照出 file 块。
// 这里钉死四件事：
//   1. 路径判定（白名单内直发 / 越界必须显式批准）不能漂；
//   2. 限额、空文件、不存在等条件必须在**入库前**拒掉；
//   3. 生成的引用必须能被 splitMediaRefs 原样解析回 kind="file"（否则三端都看不到卡片）；
//   4. 扩展里那份判定副本不能与 core 漂移（pi 子进程 import 不到主进程模块，只能复制）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

// 让 bundler 风格的无后缀相对 import（./remote/video-refs）能在纯 node 下跑起来。
register(new URL("./electron-stub-loader.mjs", import.meta.url));

const core = await import("../src/main/attach-file-core.ts");
const inbox = await import("../src/main/attach-file-inbox.ts");
const media = await import("../src/main/remote/video-refs.ts");

const ROOT = join(tmpdir(), `mpi-attach-file-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
const PROJECT = join(ROOT, "MyWorkspace", "Project", "demo");
const SANDBOX_ROOT = join(ROOT, "MyWorkspace");
mkdirSync(PROJECT, { recursive: true });
const dirs = inbox.ensureAttachFileDirs(ROOT);
assert.ok(existsSync(dirs.inboxDir) && existsSync(dirs.outboxDir), "收件箱/回执目录应自动创建");

/** 假对象库：只关心「入库拿到了什么」，真实哈希与去重由 chat-attachment-store 自己测。 */
const stored = [];
const fakeStore = (args) => {
  const size = statSync(args.sourcePath).size;
  const name = `0${"a".repeat(63)}`; // 长得像内容寻址 key，触发引用里的 key= 属性
  stored.push({ ...args, size });
  return { abs: join(ROOT, "objects", name), name, size };
};

/** 跑一轮 ingest：写请求 → 处理 → 返回回执。 */
function send(req, options = {}) {
  writeFileSync(join(dirs.inboxDir, `${req.id}.json`), JSON.stringify(req));
  const n = inbox.ingestAttachFileRequests({
    ...dirs,
    storeObject: fakeStore,
    workspaceRoot: SANDBOX_ROOT.replace(/\\/g, "/"),
    ...options,
  });
  assert.equal(n, 1, "一次请求应产出一条回执");
  const receipt = JSON.parse(readFileSync(join(dirs.outboxDir, `${req.id}.json`), "utf8"));
  rmSync(join(dirs.outboxDir, `${req.id}.json`), { force: true });
  assert.equal(readdirSync(dirs.inboxDir).length, 0, "处理完的请求文件必须删掉（否则会重复入库）");
  return receipt;
}

const FILE = join(PROJECT, "报告.pdf");
writeFileSync(FILE, "%PDF-1.4 hello");
const EMPTY = join(PROJECT, "empty.bin");
writeFileSync(EMPTY, "");

// ---- 1. 路径判定 ----------------------------------------------------------
assert.equal(core.resolveAgentPath("out/a.md", "E:/proj/x").toLowerCase(), "e:/proj/x/out/a.md".toLowerCase());
assert.equal(core.resolveAgentPath("/e/MyWorkspace/a.pdf", "E:/proj").toLowerCase(), "e:/myworkspace/a.pdf");
assert.equal(core.resolveAgentPath("E:\\a\\b\\c.zip", "E:/proj").toLowerCase(), "e:/a/b/c.zip");
assert.equal(core.resolveAgentPath("./secret/../../boot.ini", "E:/proj/x").toLowerCase(), "e:/proj/boot.ini", ".. 应被折叠");

const roots = core.allowedRoots(core.normalizePath(PROJECT), core.normalizePath(SANDBOX_ROOT));
assert.ok(core.isWithinRoots(core.resolveAgentPath("报告.pdf", PROJECT), roots), "会话工作区内的文件免审批");
assert.ok(core.isWithinRoots(core.normalizePath(`${SANDBOX_ROOT.replace(/\\/g, "/")}/Work/tempfile/a.txt`), roots), "tempfile 免审批");
assert.ok(core.isWithinRoots(core.normalizePath(`${SANDBOX_ROOT.replace(/\\/g, "/")}/Share/inbox/a.zip`), roots), "Share 交换区免审批");
assert.ok(!core.isWithinRoots("C:/Windows/win.ini", roots), "工作区外必须判为越界");
assert.ok(
  !core.isWithinRoots(`${core.normalizePath(SANDBOX_ROOT)}/../else/a.txt`, roots),
  "靠 .. 跳出 workspace 不算在内",
);

// workspace 根推不出来时宁可少放行（只剩 cwd），别把整块盘变成白名单。
const noRoot = core.allowedRoots("Q:/somewhere/deep", "");
assert.equal(noRoot.length, 1, "找不到 MyWorkspace 且没配 MPI_WORKSPACE_ROOT 时只放行 cwd");

const verdictOut = core.checkAttachRequest({ id: "v1", path: "C:/Users/me/.ssh/id_rsa", cwd: PROJECT }, { requireInsideRoots: true });
assert.equal(verdictOut.ok, false);
assert.equal(verdictOut.outsideRoots, true, "越界要标出来，调用方据此弹审批卡");
assert.equal(
  core.checkAttachRequest({ id: "v2", path: "C:/Users/me/.ssh/id_rsa", cwd: PROJECT }, { requireInsideRoots: false }).ok,
  true,
  "用户批准过（approved）之后 ingest 不再二次拒绝",
);

assert.equal(core.guessMimeType("/a/b/report.pdf"), "application/pdf");
assert.equal(core.guessMimeType("/a/obj/name-only", "台账.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
assert.equal(core.guessMimeType("/a/b/thing.unknownext"), "application/octet-stream", "认不出就明说，不猜个错的类型");

// ---- 2/3. 入库与引用文本 --------------------------------------------------
const ok = send({ id: "r1", path: "报告.pdf", cwd: PROJECT, label: "季度报告.pdf" });
assert.equal(ok.ok, true, `正常递交应成功：${ok.error || ""}`);
assert.ok(ok.key, "内容寻址的对象要在回执里带上 key");
assert.match(ok.text, /attach="media"/);
assert.match(ok.text, /kind="file"/, "引用必须标成 file，否则客户端按视频渲染");
assert.match(ok.text, /label="季度报告\.pdf"/);

// 快照生成端就是这么解析的：解析不出 kind=file 等于整条链路白做。
const parsed = media.splitVideoRefs(`正文\n${ok.text}`);
assert.equal(parsed.refs.length, 1, "引用应被剥出来");
assert.equal(parsed.refs[0].kind, "file");
assert.equal(parsed.refs[0].label, "季度报告.pdf");
assert.equal(parsed.refs[0].size, statSync(FILE).size);
assert.ok(!parsed.text.includes("<file"), "正文里不能留下原始标签");
assert.equal(stored.at(-1).mime, "application/pdf", "mime 要按扩展名推给对象库");

const empty = send({ id: "r2", path: "empty.bin", cwd: PROJECT });
assert.equal(empty.ok, false, "空文件不该入库");
assert.match(empty.error, /empty/);

const missing = send({ id: "r3", path: "nope.pdf", cwd: PROJECT });
assert.equal(missing.ok, false, "不存在的文件必须拒");
assert.match(missing.error, /not found/);

const outside = send({ id: "r4", path: "C:/Windows/win.ini", cwd: PROJECT });
assert.equal(outside.ok, false, "越界且没批准的请求，ingest 这一层也要挡住");
assert.match(outside.error, /outside/);

const big = send({ id: "r5", path: "报告.pdf", cwd: PROJECT }, { maxBytes: 4 });
assert.equal(big.ok, false, "超过单件上限必须拒");
assert.match(big.error, /limit/);

// 半截 JSON（扩展写一半进程就没了）：不能崩，也不能吞掉请求。
writeFileSync(join(dirs.inboxDir, "half.json"), `{"id":"r6","pat`);
inbox.ingestAttachFileRequests({ ...dirs, storeObject: fakeStore });
assert.ok(existsSync(join(dirs.inboxDir, "half.json")), "坏 JSON 留到下一轮再试，别静默丢请求");
rmSync(join(dirs.inboxDir, "half.json"), { force: true });

// ---- 4. 桌面渲染层同源：引用必须被剥成卡片 ------------------------------
// 主机把 file 块下发给手机，而**桌面**读的是 pi 原始正文（不经 remoteMessages），
// 所以桌面必须自己剥——没剥就会把一整行 XML 当 Markdown 显示给用户。
const renderer = await import("../src/renderer/src/lib/chat-attachments.ts");
const stripped = renderer.parseAgentMediaRefs(`报告在这。
${ok.text}`);
assert.equal(stripped.attachments.length, 1, "agent 的引用应变成一张附件卡片");
assert.equal(stripped.attachments[0].name, "季度报告.pdf", "卡片标题用 label，不是 64 位哈希名");
assert.equal(stripped.attachments[0].kind, "file");
assert.ok(stripped.attachments[0].path, "得带上对象库路径，点开才有东西");
assert.ok(!stripped.text.includes("<file"), "正文里不能残留引用原文");
assert.match(stripped.attachments[0].note, /B|KB|MB/, "副标题给个大小");

// 没有 attach 标记的 <file path=…> 是给模型读的输入文件说明，不该被吞掉。
const plain = renderer.parseAgentMediaRefs(`<file name="a.ts" path="E:/x/a.ts" note="attached file" />`);
assert.equal(plain.attachments.length, 0);
assert.match(plain.text, /<file name="a\.ts"/, "普通输入文件信封原样保留");

// 流式：标签只写了一半时先裁掉尾部，别逐字露出 XML。
const partial = renderer.parseAgentMediaRefs(`好的，文件：<file name="abc" attach="med`);
assert.equal(partial.attachments.length, 0, "半个标签还不算附件");
assert.ok(!partial.text.includes("<file"), "流式中途不应把半截 XML 显示给用户");

// 三端协议同源：主机 protocol.ts 与 PWA 那份 vendored 副本的**块类型联合**必须一致。
// （test:pwa-shared 只比函数行为，类型 union 是编译期的东西它测不到——而只改一边时
// PWA 会把 file 块当文本吞掉，不报错也不显示。）
const desktopProto = readFileSync(new URL("../src/main/remote/protocol.ts", import.meta.url), "utf8");
const sharedProto = readFileSync(new URL("../mobile/shared/protocol.ts", import.meta.url), "utf8");
const blockTypesOf = (src) => {
  const m = /type: "text" \| "thinking" \| "tool"((?: \| "[a-z]+")+);/.exec(src);
  return m ? m[1].split("|").map((s) => s.trim().replace(/"/g, "")).sort().join(",") : "";
};
assert.ok(blockTypesOf(desktopProto).includes("file"), "主机协议得认 file 块");
assert.equal(blockTypesOf(sharedProto), blockTypesOf(desktopProto), "PWA 的块类型联合与主机不一致");

// ---- 4b. 工具回执**不能**含标记语法（2026-11-04 设计修正）--------------------
// 事故：回执里写了「Put this reference verbatim into your reply」，模型就把整段
// `<file … attach="media" … />` 抄进了回答，手机端把它当正文渲染（真机反复复现）。
// 正确分工：**发送与出卡全由 MPI 内部完成**，模型只能拿到「发成了 / 叫什么」。
// 这里用源码扫描钉住这个契约：回执文案里一旦又出现可抄的标记，或又冒出
// “verbatim / paste … into your reply” 这类指令，就失败。
{
  const extSrc = readFileSync(new URL("../src/main/mpi-attach-file-ext.ts", import.meta.url), "utf8");
  // 只扫**代码**（剔除行注释）：注释里会正当引用历史文案作为反面例子。
  const code = extSrc
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  // 回执里不能把 receipt.text（引用原文）拼回给模型的文案里。
  assert.ok(
    !/text:\s*`[^`]*\$\{receipt\.text\}/s.test(code),
    "工具回执不得把 receipt.text（<file …/> 原文）交给模型——它会被抄进回答",
  );
  assert.ok(
    !/verbatim/i.test(code),
    "工具的 description/回执不得要求模型「原样贴回」引用（verbatim），这就是模型抄 XML 的根源",
  );
  // 成功回执只说发完了 + 文件名，不含任何标记属性。
  assert.ok(
    /Sent \"\$\{label\}\"/.test(code),
    "成功回执应只说「Sent \"<文件名>\" into this conversation」这类自然语言",
  );
  console.log("ok 4b - 工具回执不含标记语法（发送与出卡全由 MPI 内部完成）");

  // 回执必须带机器可读的 `mpi_attachment` 元数据（否则快照无从得知该生成什么卡片）：
  // 台账是异步写入的，而快照在工具返回时就生成（2026-11-04 实测快照先跑、登记 45s 后才到）。
  assert.ok(
    code.includes("mpi_attachment"),
    "回执必须带 {\"mpi_attachment\":{name,label,size}} 元数据——快照靠它生成文件卡片",
  );
  assert.ok(
    /label,\s*\n?\s*\.\.\.\(receipt\.size/.test(code) || code.includes("label,\n          ...(receipt.size"),
    "回执的元数据里必须包含可读文件名 label（界面标题）",
  );
  console.log("ok 4c - 回执带 mpi_attachment 机器元数据（快照据此出卡，不靠异步入库）");

  // 会话文件必须取**调用这一刻**的权威值（ctx.sessionManager），不能用 spawn 时的 env。
  // 事故（2026-11-04）：MPI_ATTACH_SESSION_FILE 是桥启动时的快照，而桥会跨会话复用——
  // 会话一换，附件就被记到另一个会话名下：当前会话快照永远查不到（`keys=1 hit=0`），
  // 补拉信号也算到别的 threadId 上。
  assert.ok(
    /ctx\?\.sessionManager\?\.getSessionFile\?\.\(\)/.test(code),
    "扩展必须优先用 ctx.sessionManager.getSessionFile() 作为会话文件（env 会过期）",
  );
  assert.ok(
    /sessionFile:\s*currentSessionFile\(ctx\)/.test(code),
    "入库请求里的 sessionFile 必须走 currentSessionFile(ctx)，否则台账键会与快照对不上",
  );
  assert.ok(
    !/sessionFile:\s*SESSION_FILE\b/.test(code),
    "入库请求不得直接用 spawn 时的 SESSION_FILE（会话换过就错位）",
  );
  console.log("ok 4e - 会话文件取运行时权威值（不被桥启动时的 env 带偏）");
}

// ---- 4d. 补拉信号的事件形状（2026-11-04 真机最后一环）--------------------
// 事故：入库后推的「去刷新」信号写成了 `kind:"agent.event"`，而两端客户端都是
// 拿 `payload.kind` 直接 switch pi 事件类型 —— 信号落进 default 被静默忽略。
// 日志上 `backfill-ping … subs=1` 看着送达，客户端却一次快照都没拉，于是
// 「切走再切回才看到卡片」。这里钉死形状，防再退回去。
{
  const ping = core.attachBackfillEvent("deadbeef1234");
  assert.equal(ping.kind, "message_start", "补拉信号的 kind 必须是 pi 事件类型（客户端 switch 的是 kind）");
  assert.notEqual(ping.kind, "agent.event", "kind 不能写成通道包装 agent.event（客户端会整帧忽略）");
  const event = ping.data.event;
  assert.equal(event.type, "message_start", "data.event.type 与 kind 必须一致，否则老客户端解码对不上");
  assert.equal(event.message.role, "user", "客户端只在 user 消息上做媒体补拉判断");
  const content = event.message.content;
  assert.ok(Array.isArray(content) && content.length === 1, "占位消息只该带一个媒体块");
  // 故意用 video：安卓/PWA 从 2026-09-28 就认 image/video，`file` 是 2026-11-04 才加的，
  // 现场的老 APK 不认 file —— 用 file 会让「不升级就永远收不到卡片」。
  assert.equal(content[0].type, "video", "占位块必须用 video（兼容老客户端），真卡片内容仍以快照为准");
  assert.equal(content[0].omitted, true, "占位块必须 omitted:true（不带本体，否则大帧）");
  assert.equal(content[0].name, "deadbeef1234", "占位块要带上对象名（诊断用）");
  console.log("ok 4d - 附件补拉信号形状正确（kind=message_start + video 占位块）");
}

// ---- 4f. 附件块类型按 mime 分发（视频/音频内联，其它下载卡）------------------
// 2026-11-04：agent 递的 mp4 以前一律生成 `file` 块 → 手机上只能下载；而用户自己发的
// 视频是内联播放器。差异全在块类型，所以这里钉住分发规则（video/audio 块本来就支持
// 「快照只给名字、点开按需拉本体」，不需要新协议）。
{
  const refs = await import("../src/main/chat-attachment-refs.ts");
  // 扩展只把路径交给主机，mime 可能是 octet-stream（=「不知道」），必须靠文件名兜底。
  assert.deepEqual(
    refs.attachBlockPlan({ label: "a.mp4" }, "application/octet-stream"),
    { type: "video", mimeType: "video/mp4" },
    "mp4 + octet-stream 必须出 video 块（否则手机只能降级成下载卡）",
  );
  assert.deepEqual(refs.attachBlockPlan({ label: "a.mp4" }, "video/mp4"), { type: "video", mimeType: "video/mp4" });
  assert.deepEqual(refs.attachBlockPlan({ label: "a.mp3" }, "audio/mpeg"), { type: "audio", mimeType: "audio/mpeg" });
  assert.deepEqual(refs.attachBlockPlan({ label: "a.mp3" }, "application/octet-stream"), {
    type: "audio",
    mimeType: "audio/mpeg",
  });
  assert.equal(
    refs.attachBlockPlan({ label: "测试6.docx" }, "application/vnd.openxmlformats-officedocument.wordprocessingml.document").type,
    "file",
    "文档仍是下载卡（不能因为扩展名不认识就当视频）",
  );
  // 图片：要能直接在气泡里看到（image 块 + 快照内联缩略图），不是下载卡。
  assert.deepEqual(refs.attachBlockPlan({ label: "shot.png" }, "application/octet-stream"), { type: "image", mimeType: "image/jpeg" });
  assert.deepEqual(refs.attachBlockPlan({ label: "shot.jpg" }, "image/jpeg"), { type: "image", mimeType: "image/jpeg" });
  assert.equal(refs.attachBlockPlan({ label: "a.zip" }, "application/zip").type, "file");
  console.log("ok 4f - 附件块类型按 mime 分发（mp4/mp3 → video/audio，文档 → file）");
}

// ---- 4h. 台账兜底去重必须含 image（真机：手机端同一张图出现两次）----------
// 事故（2026-11-05）：快照里回执元数据已经出过一次 image 块，台账兜底又追加了同一张图——
// 去重集合只收 file/video/audio，漏了 image。
{
  const refs = await import("../src/main/chat-attachment-refs.ts");
  const blocks = [
    { type: "text", text: "发好了" },
    { type: "image", name: "img1" },
    { type: "video", name: "vid1" },
    { type: "audio", name: "aud1" },
    { type: "file", name: "doc1" },
    { type: "tool", name: "bash" },
  ];
  const names = refs.mediaBlockNames(blocks);
  assert.deepEqual(names.sort(), ["aud1", "doc1", "img1", "vid1"], "四种媒体块都要收（含 image），文本/工具块不收");
  assert.deepEqual(refs.mediaBlockNames(undefined), []);
  // 台账兜底的实际判定：已经在快照里的对象不能再补一块。
  const already = new Set(names);
  const pending = [{ name: "img1" }, { name: "new2" }].filter((e) => !already.has(e.name));
  assert.deepEqual(pending.map((e) => e.name), ["new2"], "已出现过的图片不能被台账重复追加");
  console.log("ok 4h - 台账去重含 image（图片不会被追加两次）");
}

// ---- 4g. GC 必须把 mpi_attachment 的对象名算进 live-set -------------------
// 事故隐患（2026-11-04）：这类附件不写 `<file … attach="…" />`，只在工具回执里留一行
// JSON。引用集合以前只认 attach 属性，于是对象区一超 1GB 就被当成「没人引用」删掉，
// 历史里只剩一张点不开的卡片。
{
  const gc = await import("../src/main/attachment-gc.ts");
  const name = "733744aee84cd02ca097c4297e2b5fc0e178d921f4d7300283f3ff12087f29c3";
  const receipt = JSON.stringify({ mpi_attachment: { name, label: "测试6.docx", size: 10255 } });
  assert.deepEqual(gc.attachMetaNames(receipt), [name], "工具回执里的对象名必须能被采集出来");
  // 会话 JSONL 里是转义过的：GC 先 collectJsonStrings 解码，这里也用嵌套形式过一遍。
  const escaped = JSON.parse(JSON.stringify(receipt));
  assert.deepEqual(gc.attachMetaNames(escaped), [name]);
  assert.deepEqual(gc.attachMetaNames("普通消息，没有附件元数据"), []);
  assert.deepEqual(gc.attachMetaNames('{"mpi_attachment":{"label":"x"}}'), [], "没有 name 时不能报出脏名字");
  console.log("ok 4g - GC 的 live-set 含 mpi_attachment 对象名");
}

// ---- 5. 扩展副本与 core 的同步哨兵 ---------------------------------------
// pi 子进程 import 不到主进程模块，判定逻辑只能复制一份（同 permission-gate-ext 的
// SAFE_TOOLS 约定）。这是文本级哨兵，不是等价性证明——真正跑通看上面的用例 + 手动验证。
const extSource = readFileSync(new URL("../src/main/mpi-attach-file-ext.ts", import.meta.url), "utf8");
for (const [what, needle] of [
  ["128MB 上限", "128 * 1024 * 1024"],
  ["tempfile 免审批根", "/Work/tempfile"],
  ["Share 免审批根", "/Share"],
  ["MyWorkspace 兜底探测", `"myworkspace"`],
  ["Git Bash 路径形式", String.raw`/^\/([a-zA-Z])\/(.+)$/`],
]) {
  assert.ok(extSource.includes(needle), `扩展里的判定副本与 core 漂移了：缺少${what}（${needle}）`);
}
assert.ok(!/MUTATING_TOOL_NAME/.test(extSource), "工具名 mpi_attach_file 不该出现在 gate 的 mutating 名单里");

rmSync(ROOT, { recursive: true, force: true });
console.log("✓ test-attach-file 全部通过");
