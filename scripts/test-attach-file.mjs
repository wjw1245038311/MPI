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
