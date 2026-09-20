/**
 * /memory 命令的池子读取逻辑测试。
 *
 * 特殊做法：扩展文件（mpi-memory-ext.ts）是自包含的、import 不到本仓模块，
 * 所以这里**从扩展源码里抽出那段逻辑再跑**（而不是复制一份），避免两处漂移。
 * 运行：npm run test:memorycmd
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "esbuild";

const SRC = "src/main/mpi-memory-ext.ts";
const src = readFileSync(SRC, "utf8");
const start = src.indexOf("interface PoolCard");
const end = src.indexOf("// 捕获主流程");
assert.ok(start > 0 && end > start, "能从扩展源码里定位到池子读取段");
const block = src.slice(start, end).replace(/^export /gm, "");
const js = (await transform(block, { loader: "ts", target: "es2022" })).code;
const factory = new Function("readFileSync", "readdirSync", "join", `${js}\nreturn { parsePoolFile, readPool, searchPool };`);
const { parsePoolFile, readPool, searchPool } = factory(readFileSync, readdirSync, join);

let n = 0;
const ok = (name) => {
  n++;
  console.log(`  ✅ ${name}`);
};

const dir = mkdtempSync(join(tmpdir(), "mpi-memcmd-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const seg = join(dir, "inbox", "2026-09");
mkdirSync(seg, { recursive: true });

const entry = (id, created, importance, text, extra = "") => `---
id: ${id}
created_at: "${created}"
type: semantic
temporal: retrospective
importance: ${importance}
relevance: 0.7
recurrence: 1
project: MPI
source: "test"
status: inbox
promoted_to: null
tags: []
${extra}---

${text}

## 证据
- \`src/a.ts:1\`
`;
writeFileSync(join(seg, "01A.md"), entry("01A", "2026-09-20T10:00:00+08:00", 9, "推送前必须等用户确认。"), "utf8");
writeFileSync(join(seg, "01B.md"), entry("01B", "2026-09-20T12:00:00+08:00", 5, "临时文件落在 tempfile 目录下。"), "utf8");
writeFileSync(join(seg, "01C.md"), entry("01C", "2026-09-21T09:00:00+08:00", 7, "zvec 的 open 约 208 毫秒，读者必须复用句柄。"), "utf8");
writeFileSync(join(seg, "broken.md"), "没有 frontmatter 的垃圾\n", "utf8");
writeFileSync(join(seg, "01D.md"), entry("01D", "2026-09-19T09:00:00+08:00", 6, "正文被注释包着<!-- 待补充：随便 -->后的内容。"), "utf8");

const one = parsePoolFile(entry("01X", "2026-09-20T10:00:00+08:00", 8, "单条解析测试。", 'tags: [a, b]\n'), "x.md");
assert.equal(one.id, "01X");
assert.equal(one.importance, 8);
assert.equal(one.text, "单条解析测试。");
assert.equal(parsePoolFile("没有 frontmatter", "y.md"), null, "坏输入返回 null");
assert.equal(parsePoolFile("---\nid: 01Z\n---\n\n<!-- 只有注释 -->\n", "z.md"), null, "空正文返回 null（注释不算正文）");
ok("parsePoolFile：字段/正文/注释处理正确，坏输入不抛");

const cards = readPool(dir);
assert.equal(cards.length, 4, "4 条有效条目（broken.md 被跳过）");
assert.deepEqual(cards.map((c) => c.id), ["01C", "01B", "01A", "01D"], "按创建时间倒序");
assert.equal(cards.find((c) => c.id === "01D").text, "正文被注释包着后的内容。", "正文里的 HTML 注释被剥掉");
ok("readPool：跳过坏文件、倒序、注释剥离");

const hit = searchPool(cards, "句柄");
assert.equal(hit[0]?.id, "01C", "关键词命中正确条目");
assert.equal(searchPool(cards, "完全不相干的词").length, 0, "无命中返回空");
const multi = searchPool(cards, "推送 确认");
assert.equal(multi[0]?.id, "01A", "多词命中");
assert.equal(searchPool(cards, "", 2).length, 2, "空查询返回前 N 条");
ok("searchPool：关键词/多词/空查询行为正确");

// 空池不应该炸
const empty = mkdtempSync(join(tmpdir(), "mpi-memcmd-empty-"));
assert.deepEqual(readPool(empty), [], "池目录不存在时返回空数组");
assert.deepEqual(readPool(""), [], "未配置池目录时返回空数组");
rmSync(empty, { recursive: true, force: true });
ok("空池 / 未配置池目录都不炸");


// --- 补全（/memory 系列）-----------------------------------------------------
{
  const start2 = src.indexOf("const ac = (value: string, label: string)");
  const end2 = src.indexOf("/** 检索：语义优先");
  assert.ok(start2 > 0 && end2 > start2, "能定位到补全工具");
  const block2 = src.slice(start2, end2).replace(/^export /gm, "");
  const js2 = (await transform(block2, { loader: "ts", target: "es2022" })).code;
  const f2 = new Function("readPool", "POOL_DIR", js2 + "return { acFilter, cardCompletions };");
  const { acFilter, cardCompletions } = f2(() => cards, dir);

  const sub = acFilter([{ value: "list", label: "list" }, { value: "find ", label: "find <词>" }], "fi");
  assert.equal(sub.length, 1, "按前缀过滤子命令");
  assert.equal(sub[0].value, "find ", "命中 find");
  assert.equal(acFilter([{ value: "list", label: "list" }], "zzz"), null, "无匹配返回 null");
  assert.equal(acFilter([{ value: "list", label: "list" }], "").length, 1, "空前缀返回全部");

  const comp = cardCompletions("");
  assert.equal(comp.length, cards.length, "条目数一致");
  assert.equal(comp[0].value, cards[0].id, "value 是 id（可直接喂给 /memory-forget）");
  assert.ok(comp[0].label.includes(cards[0].text.slice(0, 12)), "label 带正文预览");
  assert.equal(cardCompletions("根本没有的id"), null, "无匹配 → null");
  ok("补全：/memory 子命令、/memory-forget 用池内条目、空前缀与无匹配行为正确");
}

// --- 提案命令契约（源码级）：真事故防回归 -------------------------------------
//
// 事故：列表里显示 id 后 6 位，但查找只按**前缀**匹配 → 人抄后缀就"找不到提案"。
// 这类契约（注册了哪些命令、补全返回什么、查找接受什么）用源码级检查钉住：
// 扩展是自包含、跑在 pi runtime 里的，没法在单测里加载它（typebox 由 pi 提供）。
{
  const { readFileSync: rf } = await import("node:fs");
  const ext = rf(new URL("../src/main/mpi-memory-ext.ts", import.meta.url), "utf8");

  for (const name of ["memory", "memory-remember", "memory-search", "memory-tour", "memory-status", "memory-forget", "memory-dream", "memory-proposals", "memory-approve", "memory-reject"]) {
    assert.ok(ext.includes(`registerCommand("${name}"`), `应注册命令 /${name}`);
  }
  ok("命令族完整（10 个命令都在）");

  // 查找必须同时接受前缀与后缀
  assert.ok(ext.includes("p.id.startsWith(needle) || p.id.endsWith(needle)"), "findProposal 必须接受前缀或后缀");
  // 歧义不猜
  assert.ok(ext.includes("hits.length > 1"), "多个匹配时必须提示歧义而不是随便挑一个");

  // 补全的 value 用短柄（后 8 位）
  const approveBlock = ext.slice(ext.indexOf('registerCommand("memory-approve"'), ext.indexOf('registerCommand("memory-reject"'));
  assert.ok(approveBlock.includes("ac(p.id.slice(-8)"), "approve 补全的 value 应是短柄（后 8 位）");
  const rejectBlock = ext.slice(ext.indexOf('registerCommand("memory-reject"'));
  assert.ok(rejectBlock.includes("ac(p.id.slice(-8)"), "reject 补全的 value 应是短柄（后 8 位）");

  // 点选链路：提案列表必须提供动作菜单（否则又得手敲 id）
  assert.ok(ext.includes("async function proposalActionMenu"), "应有「点一条 → 选动作」的菜单");
  assert.ok(/picked\s*===\s*"批准并落地"/.test(ext), "菜单里应有批准动作");
  assert.ok(/picked\s*===\s*"拒绝"/.test(ext), "菜单里应有拒绝动作");
  // MPI 选择卡片回传的是 label 字符串 → 必须按 label 回找，不能靠索引
  assert.ok(ext.includes("options.findIndex((o) => o.label === picked)"), "必须按回传的 label 回找提案");
  assert.ok(ext.includes("async function pickProposal"), "应有共用的点选函数（label 回找逻辑只写一份）");
  // 不带参数的 approve/reject 必须直接弹列表（手敲 id 是反人性的）
  const approveHandler = ext.slice(ext.indexOf('registerCommand("memory-approve"'), ext.indexOf('registerCommand("memory-reject"'));
  assert.ok(approveHandler.includes("选择要批准的提案"), "memory-approve 不带参数应直接弹列表");
  const rejectHandler = ext.slice(ext.indexOf('registerCommand("memory-reject"'));
  assert.ok(rejectHandler.includes("选择要拒绝的提案"), "memory-reject 不带参数应直接弹列表");
  ok("提案交互契约：前缀/后缀都可查、短柄补全、列表可点选批准/拒绝/看正文");
}

console.log(`\ntest:memorycmd 全部通过（${n} 项）`);

