import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  CHANGELOG_PATH,
  parseChangelog,
  signature,
  classifyUserFacing,
  suggestChapter,
  computePending,
  defaultState,
} = await import("./manual-sync.mjs");

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

const SAMPLE = `# Changelog

## Unreleased

1. **设置页重新分类：9 栏 → 7 栏**
   验证方式：打开设置逐栏检查。

2. **自动化测试面板（P2）：新增「新建会话模拟」视图**
   验证方式：跑 harness。

## v0.6.9（2026-09-12）

1. **任务模式整合：内置 4 个模式**
   验证方式：dev 重启。

2. **开发工具下拉（dev-only）**
   验证方式：dev 构建可见。

## v0.6.8（2026-09-10）

1. **旧版本条目**
   验证方式：无。
`;

// --- 解析 -------------------------------------------------------------------
{
  const sections = parseChangelog(SAMPLE);
  assert.equal(sections.length, 3, "三个分节");
  assert.equal(sections[0].title, "Unreleased");
  assert.equal(sections[0].items.length, 2, "Unreleased 两条");
  assert.equal(sections[1].title, "v0.6.9（2026-09-12）");
  assert.equal(sections[1].items[0].number, 1);
  assert.ok(sections[1].items[0].title.includes("任务模式整合"), "标题正确");
  assert.ok(!sections[1].items[0].title.includes("验证方式"), "续行未被并入标题");
  ok("parseChangelog 分节与条目解析正确、忽略缩进续行");
}

// --- 签名 -------------------------------------------------------------------
{
  assert.equal(signature("**设置页重新分类：9 栏 → 7 栏**"), "设置页重新分类：9 栏 → 7 栏");
  assert.equal(signature("任务模式整合（迭代 skill）：很长的说明文字"), "任务模式整合");
  assert.ok(signature("x".repeat(200)).length <= 40, "截断到 40 字");
  ok("signature 去粗体/去括号/折叠空白/截断");
}

// --- 用户可见性判定 ---------------------------------------------------------
{
  assert.equal(classifyUserFacing("设置页重新分类：9 栏 → 7 栏"), true);
  assert.equal(classifyUserFacing("语音系统新增自动朗读"), true);
  assert.equal(classifyUserFacing("自动化测试面板（P2）：新增「新建会话模拟」视图"), false);
  assert.equal(classifyUserFacing("功能测试注册表 + 测试运行器"), false);
  assert.equal(classifyUserFacing("开发工具下拉（dev-only）"), false);
  assert.equal(classifyUserFacing("测试文档分立：E2E-TESTING 与 FEATURE-TESTING"), false);
  assert.equal(classifyUserFacing("pure refactor 重构：内部字段重命名"), false);
  ok("classifyUserFacing 正确区分用户可见与内部（测试/dev/文档/重构）");
}

// --- 章节建议 ---------------------------------------------------------------
{
  assert.match(suggestChapter("任务模式内置改为指令"), /与智能体对话/);
  assert.match(suggestChapter("权限模式工具信任列表"), /权限模式/);
  assert.match(suggestChapter("设置页重新分类"), /设置参考/);
  assert.equal(suggestChapter("毫无关键词的条目"), "?");
  ok("suggestChapter 按主题给出章节建议");
}

// --- 差分：基准在中间 -------------------------------------------------------
{
  const sections = parseChangelog(SAMPLE);
  const state = { ...defaultState(), syncedThrough: "v0.6.9", unreleased: [] };
  const r = computePending(sections, state);
  assert.equal(r.unknownVersion, false);
  // Unreleased 2 条；v0.6.9 位于基准处不再列出；v0.6.8 更旧不列出
  assert.equal(r.pending.length, 1, "仅设置页条目为用户可见");
  assert.equal(r.skipped.length, 1, "测试面板为内部");
  assert.ok(r.pending.every((p) => p.section === "Unreleased"), "只列 Unreleased");
  ok("computePending 只返回基准之后的条目，并按可见性分流");
}

// --- 差分：按签名去重已同步 -------------------------------------------------
{
  const sections = parseChangelog(SAMPLE);
  const sig = signature("**设置页重新分类：9 栏 → 7 栏**");
  const state = { ...defaultState(), syncedThrough: "v0.6.9", unreleased: [sig] };
  const r = computePending(sections, state);
  assert.equal(r.pending.length, 0, "已同步条目被排除");
  assert.equal(r.skipped.length, 1);
  ok("computePending 通过签名排除已同步条目（抗重编号）");
}

// --- 差分：基准未知 ---------------------------------------------------------
{
  const sections = parseChangelog(SAMPLE);
  const state = { ...defaultState(), syncedThrough: "v9.9.9", unreleased: [] };
  const r = computePending(sections, state);
  assert.equal(r.unknownVersion, true, "找不到基准版本时给出标记");
  ok("computePending 对未知基准版本给出 unknownVersion");
}

// --- 真实 changelog 冒烟 ----------------------------------------------------
{
  const sections = parseChangelog(readFileSync(CHANGELOG_PATH, "utf8"));
  assert.ok(sections.length >= 1, "至少一个分节");
  assert.ok(sections.every((s) => s.items.length >= 1), "每个已存在分节至少有 1 条");
  // 发版会把 Unreleased 改名为 vX（日期），故此处不要求 Unreleased 存在
  const released = sections.filter((s) => /^v\d/.test(s.title));
  assert.ok(released.length >= 1, "至少一个已发布版本分节");
  ok("真实 changelog.md 可解析（不依赖 Unreleased 是否存在）");
}

console.log(`\nmanual-sync: ${passed} group(s) passed`);
