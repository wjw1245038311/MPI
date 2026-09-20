/**
 * 当前任务聚合测试（P4）
 *
 * 三层来源的读取与摘要都是纯文件操作（不带 electron），所以能直接单测。
 * 重点钉住：坏文件不炸、只扫一层、正序/倒序、changelog 浅解析的边界。
 *
 * 运行：npm run test:tasks
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { aggregateTasks, listHandoffs, readChangelog } = await import("../src/main/task-aggregate.ts");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

// --- HANDOFF：只扫一层、按时间倒序、坏文件不炸 --------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-tasks-handoff-"));
  writeFileSync(join(dir, "HANDOFF-2026-09-18.md"), "# 交接：记忆池 P0-P2\n\n细节……\n", "utf8");
  writeFileSync(join(dir, "handoff-old.md"), "---\ntitle: x\n---\n\n## 旧的交接\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# 不是交接\n", "utf8");
  // 子目录里的不算（HANDOFF 是"放手边给人看的"，递归会翻出归档旧文件）
  mkdirSync(join(dir, "archive"));
  writeFileSync(join(dir, "archive", "HANDOFF-2020.md"), "# 归档里的\n", "utf8");
  // 坏文件（目录名伪装成 md）与空文件
  writeFileSync(join(dir, "HANDOFF-empty.md"), "", "utf8");

  // 显式设定 mtime：不要依赖"写入顺序"或时间戳粒度（那样测试会飘）
  const now = Date.now() / 1000;
  utimesSync(join(dir, "HANDOFF-2026-09-18.md"), now - 10, now - 10); // 最新
  utimesSync(join(dir, "HANDOFF-empty.md"), now - 100, now - 100); // 中间
  utimesSync(join(dir, "handoff-old.md"), now - 864000, now - 864000); // 最旧

  const list = listHandoffs(dir);
  assert.equal(list.length, 3, "三份 HANDOFF（README 不算、子目录不算）");
  assert.deepEqual(
    list.map((x) => x.name),
    ["HANDOFF-2026-09-18.md", "HANDOFF-empty.md", "handoff-old.md"],
    "按修改时间倒序（显式设定的 mtime 决定顺序）",
  );
  assert.ok(list[0].title.includes("记忆池"), `标题取首个非空行：${list[0].title}`);
  assert.ok(list[2].title.includes("旧的交接"), "frontmatter 被跳过后取标题");
  assert.equal(list[1].title, "HANDOFF-empty.md", "空文件退回文件名（不会给出空标题）");
  ok("HANDOFF：只扫一层、README 不算、按修改时间倒序、跳过 frontmatter 取标题");

  const missing = listHandoffs(join(dir, "不存在的目录"));
  assert.deepEqual(missing, [], "目录不存在返回空数组（不抛）");
  ok("HANDOFF：目录不存在安全返回空");
  rmSync(dir, { recursive: true, force: true });
}

// --- changelog：Unreleased 判定 + 条目浅解析 ----------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-tasks-changelog-"));
  const NL = String.fromCharCode(10);
  const file = join(dir, "changelog.md");
  const lines = [
    "# MPI Changelog",
    "",
    "维护约定：……",
    "",
    "## Unreleased",
    "",
    "1. **记忆池面板支持批量操作**：条目与提案各自带勾选框……",
    "",
    "   验证方式：npm run test:memorypanel",
    "",
    "2. **修复某项**：先说明原因。再补细节。",
    "",
    "## v0.6.26（2026-09-20）",
    "",
    "1. **修复 choices 块偶发不渲染**：模型有时把闭合贴在同一行。",
    "",
    "## v0.6.25（2026-09-20）",
    "",
    "1. **修复压缩后上下文弹窗**：usage 缺 cost 字段。",
    "",
  ];
  writeFileSync(file, lines.join(NL), "utf8");

  const c = readChangelog(file);
  assert.ok(c, "能解析");
  assert.equal(c.hasUnreleased, true, "有 Unreleased");
  assert.equal(c.recent.length, 2, "只取最近两个版本");
  assert.equal(c.recent[0].version, "Unreleased");
  assert.equal(c.recent[0].items.length, 2, "Unreleased 两条");
  assert.ok(c.recent[0].items[0].includes("批量操作"), "条目首句保留");
  assert.ok(!c.recent[0].items[0].includes("验证方式"), "验证方式那行不算条目");
  // 条目取「冒号/句号之前」的摘要：面板列表里 "修复某项" 比整句更好扫读
  assert.equal(c.recent[0].items[1], "修复某项", "在冒号处截断成摘要");
  assert.equal(c.recent[1].version, "v0.6.26（2026-09-20）");
  ok("changelog：Unreleased 判定、只取最近两版、条目按首句截断、正文行不算条目");

  assert.equal(readChangelog(join(dir, "没有.md")), null, "文件不存在返回 null");
  const noUnrel = join(dir, "no-unreleased.md");
  writeFileSync(noUnrel, ["## v1.0.0", "", "1. 第一条。"].join(NL), "utf8");
  assert.equal(readChangelog(noUnrel).hasUnreleased, false, "没有 Unreleased 时标记为 false（面板提示「无未发版条目」）");
  ok("changelog：无 Unreleased 时正确标记；文件缺失返回 null");
  rmSync(dir, { recursive: true, force: true });
}

// --- 聚合：多个 HANDOFF 目录去重 + 真实 changelog 可解析 ----------------------
{
  const a = mkdtempSync(join(tmpdir(), "mpi-tasks-a-"));
  const b = mkdtempSync(join(tmpdir(), "mpi-tasks-b-"));
  writeFileSync(join(a, "HANDOFF-a.md"), "# A 的交接\n", "utf8");
  writeFileSync(join(b, "HANDOFF-b.md"), "# B 的交接\n", "utf8");

  const agg = aggregateTasks({ handoffDirs: [a, b, null, undefined, a] });
  assert.equal(agg.handoffs.length, 2, "两个目录各一份（重复传同一目录要去重）");
  assert.ok(agg.searched.length >= 2, "记录找过哪些目录（面板显示「找过哪里」）");
  ok("聚合：多目录合并 + 去重 + 记录搜索路径（找不到时能排查）");

  // 真实 changelog：repo 里那份必须能解析出结构
  const repo = join(process.cwd(), "changelog.md");
  if (existsSync(repo)) {
    const real = readChangelog(repo);
    assert.ok(real && real.recent.length > 0, "本仓 changelog 能解析出至少一个版本");
    assert.ok(real.recent[0].items.length >= 1, "最近一版至少一条改动");
    ok(`真实 changelog 可解析（最近：${real.recent[0].version}，${real.recent[0].items.length} 条）`);
    void readFileSync;
  }
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
}

console.log(`\ntest:tasks 全部通过（${n} 项）`);
