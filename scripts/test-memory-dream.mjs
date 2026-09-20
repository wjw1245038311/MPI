/**
 * dream 分诊测试（P3-c）
 *
 * 用**桩模型**而不是真模型：这里要验的是"模型给什么答案 → 我们怎么路由/怎么落盘"。
 * 真模型的输出质量是另一回事（那属于提示词调优，实测结论见下），不该混进单元测试。
 *
 * 真机实测记录（写在这里，防止后人再踩）：
 *   - "让模型归并主题 + 六问" + max_tokens 4000 → 66s、思考 token 吃满、content 空
 *   - 同上 max_tokens 12000 → 198s、仍为空
 *   - 改成"逐条分类 + 提示词末尾 /no_think" → 8 条 30s、finish_reason=stop、输出规整
 *   所以：**关思考 + 逐条紧凑输出**是这套本机模型的正确用法。
 *
 * 运行：npm run test:dream
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { runDream, extractJson, parseClassifyLines, lessonFileFor, titleFromEntry, clipTitle, existingLessonFor } = await import(
  "../src/main/memory-dream.ts"
);
const { listProposals, readProposal, writeProposal } = await import("../src/main/zhiya/proposals.ts");
const { decideIngest, lexicalSimilarity, listEntries, newId } = await import("../src/main/zhiya/pool.ts");
const { loadConsolidation, noteIngest, markConsolidated, consolidationDue } = await import(
  "../src/main/zhiya/consolidation.ts"
);
const { CONSOLIDATION_THRESHOLD } = await import("../src/main/zhiya/triage.ts");

/** 假的"项目根目录"：测试只关心路径字符串怎么流转，不该写死本机盘符。 */
const fakeRoot = join(tmpdir(), "mpi-fake-project");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

function seedPool(items) {
  const pool = mkdtempSync(join(tmpdir(), "mpi-dream-"));
  for (const it of items) {
    decideIngest(
      pool,
      {
        text: it.text,
        type: it.type ?? "semantic",
        temporal: it.temporal ?? "retrospective",
        importance: it.importance ?? 7,
        relevance: 0.7,
        project: it.project ?? "MPI",
        projectRoot: it.projectRoot === null ? undefined : (it.projectRoot ?? fakeRoot),
        source: "test",
      },
      lexicalSimilarity,
    );
  }
  return pool;
}

/** 造一行分类输出：id|stillValid|procedural|crossSession|activeTask|everySession|projectKnowledge */
const line = (id, [a, b, c, d, e, f]) => `${id}|${a}|${b}|${c}|${d}|${e}|${f}`;

// --- 分类行解析（这是新的关键契约）------------------------------------------
{
  const id1 = newId();
  const id2 = newId();
  const raw = [
    "id|stillValid|procedural|crossSession|activeTask|everySession|projectKnowledge", // 表头要忽略
    line(id1, [true, false, true, false, false, true]),
    `  ${line(id2, [true, true, false, false, false, false])}  `, // 前后空白
    "01HALLUCINATEDID0000000000|true|false|true|false|false|true", // 幻觉 id 要丢
    "|true|false", // 字段不足要报告
    "",
  ].join("\n");
  const { answers, errors } = parseClassifyLines(raw, [{ id: id1 }, { id: id2 }]);
  assert.equal(answers.size, 2, "只接受有效 id");
  assert.deepEqual(answers.get(id1), {
    stillValid: true,
    procedural: false,
    crossSession: true,
    activeTask: false,
    everySession: false,
    projectKnowledge: true,
  });
  assert.equal(answers.get(id2).procedural, true, "前后空白不影响解析");
  assert.equal(errors.some((e) => e.includes("字段不足")), true, `字段不足要报告：${errors.join("；")}`);
  ok("分类行解析：忽略表头、容忍空白、丢幻觉 id、字段不足要报错");

  // 真机实测：本机模型会整体省掉 id 列，只给六个布尔 → 按行序对齐 + 必须报警
  const positional = parseClassifyLines(
    ["true|false|true|false|false|true", "false|false|false|false|false|true"].join("\n"),
    [{ id: id1 }, { id: id2 }],
  );
  assert.equal(positional.answers.size, 2, "按行序也能对齐");
  assert.equal(positional.answers.get(id1).stillValid, true);
  assert.equal(positional.answers.get(id2).stillValid, false, "第二行归第二条");
  assert.ok(positional.errors.some((e) => e.includes("省略了 id")), "必须报警（不能默默对齐）");

  // 行数不匹配时不能瞎对齐
  const mismatch = parseClassifyLines("true|false|true|false|false|true", [{ id: id1 }, { id: id2 }]);
  assert.equal(mismatch.answers.size, 0, "行数不匹配 → 不对齐");
  assert.ok(mismatch.errors.some((e) => e.includes("行数不匹配")), "要说明原因");
  ok("模型省略 id 列：行数相符则按行序对齐并报警，行数不符则不猜");
}

// --- 四出口路由（逐条）-----------------------------------------------------
{
  const pool = seedPool([
    { text: "pi 扩展以 ?raw 源码写进 userData，不能 import 本仓模块。" },
    { text: "提交前必须等用户确认再 push。", type: "procedural", temporal: "prospective", project: "global", projectRoot: null },
    { text: "这条记忆已经过期了，不再成立。", temporal: "present" },
    { text: "这一轮任务的临时决定，任务还没做完。", temporal: "present" },
  ]);
  const byText = (t) => listEntries(pool).entries.find((e) => e.text.startsWith(t)).id;

  const stub = async (sys, user, maxTokens) => {
    if (sys.includes("记忆分诊器")) {
      return [
        line(byText("pi 扩展以 ?raw"), [true, false, true, false, false, true]), // → kb
        line(byText("提交前必须等用户确认"), [true, true, true, false, false, false]), // → inject（程序性）
        line(byText("这条记忆已经过期"), [false, false, false, false, false, false]), // → archive
        line(byText("这一轮任务的临时决定"), [true, false, false, true, false, false]), // → now
      ].join("\n");
    }
    if (sys.includes("经验文档")) return "---\nlesson: ext-self-contained\n---\n\n# Ext must be self contained\n\n## Guard\n\n自包含。\n";
    return "永远等用户确认后再推送。";
  };

  const r = await runDream({ poolDir: pool, chat: stub, log: () => {}, llmClassify: true });
  assert.equal(r.ok, true, `dream 应成功：${r.errors.join("；")}`);
  assert.equal(r.entries, 4);
  assert.equal(r.classified, 4);
  assert.equal(r.proposals.length, 4, "四条各出一份提案");
  const kinds = r.proposals.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ["archive", "promote-inject", "promote-kb", "promote-now"], "四个出口都走到");

  const kb = r.proposals.find((p) => p.kind === "promote-kb");
  assert.equal(kb.target, join(fakeRoot, ".alexandria", "knowledge", "lessons", "ExtSelfContained.md"));
  assert.ok(kb.body.includes("## Guard"), "kb 正文是 lesson 文档");
  assert.ok(kb.title.includes("Ext must be self contained"), `kb 标题取自 lesson 文档：${kb.title}`);
  assert.equal(kb.status, "pending");

  const arc = r.proposals.find((p) => p.kind === "archive");
  assert.equal(arc.body, "", "归档不需要正文");
  assert.ok(arc.reason.includes("已不成立"), `归档理由要写清：${arc.reason}`);
  assert.ok(arc.reason.includes("复现"), "理由里带上复现/重要性（人审要看）");

  assert.equal(readProposal(pool, kb.id)?.kind, "promote-kb", "提案落盘可读回");
  ok("四出口逐条路由：kb 带目标路径与 lesson 标题、inject/now 待人工合并、archive 无正文");
  rmSync(pool, { recursive: true, force: true });
}

// --- 漏答兜底 / 幻觉 id -----------------------------------------------------
{
  const pool = seedPool([{ text: "条目甲：这条要用来验证模型漏答时的兜底行为。" }, { text: "条目乙：长度也要够，否则会被内容过滤器拦下。" }]);
  const ids = listEntries(pool).entries.map((e) => e.id);
  const stub = async (sys) => {
    if (sys.includes("记忆分诊器")) return line(ids[1], [true, false, true, false, false, true]); // 漏了 ids[0]
    return "正文";
  };
  const r = await runDream({ poolDir: pool, chat: stub, llmClassify: true });
  assert.equal(r.proposals.length, 2, "漏答的条目也要出提案（不能静默丢）");
  assert.ok(r.errors.some((e) => e.includes("漏答")), `要报告漏答：${r.errors.join("；")}`);
  const missing = r.proposals.find((p) => p.entries[0] === ids[0]);
  assert.equal(missing.kind, "promote-kb", "兜底默认值：仍成立+跨会话+本项目的项目 → kb");
  ok("模型漏答：按保守默认兜底并明确报告（绝不静默丢条目）");
  rmSync(pool, { recursive: true, force: true });
}


// --- 默认路径：启发式判定（不调模型，瞬时）-------------------------------------
{
  const pool = seedPool([
    { text: "提交前必须等用户确认再 push。", type: "procedural", temporal: "prospective", project: "global", projectRoot: null },
    { text: "zvec 的 ZVecOpen 要 208ms，必须复用句柄。" },
    { text: "这条做法已经废弃，不再适用。", temporal: "present" },
    { text: "本轮临时记一下：先跑测试再打包。", temporal: "present" },
  ]);
  const calls = [];
  const stub = async (sys) => {
    calls.push(sys.slice(0, 10));
    return "正文";
  };
  const r = await runDream({ poolDir: pool, chat: stub, log: () => {} });
  assert.equal(r.proposals.length, 4);
  assert.equal(r.classified, 4, "启发式也必须给出全部条目的判定");
  assert.equal(calls.length, 3, "4 条里 1 条归档不需要正文 → 只调 3 次正文生成");
  const kinds = r.proposals.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ["archive", "promote-inject", "promote-kb", "promote-now"], "启发式四出口都走通");
  assert.ok(r.errors.every((e) => !e.includes("模型")), `不该有模型相关错误：${r.errors.join("；")}`);
  ok("默认启发式判定：不调模型即可完成四出口路由（快速、可复现）");
  rmSync(pool, { recursive: true, force: true });
}

// --- 已有提案去重（防止每次 dream 都刷重复提案）-----------------------------
{
  const pool = seedPool([{ text: "会被处理两次的条目，内容长度要够才不会先被过滤。" }]);
  const id = listEntries(pool).entries[0].id;
  const stub = async (sys) => (sys.includes("记忆分诊器") ? line(id, [true, false, true, false, false, true]) : "正文");

  const r1 = await runDream({ poolDir: pool, chat: stub, llmClassify: true });
  assert.equal(r1.proposals.length, 1);
  const r2 = await runDream({ poolDir: pool, chat: stub, llmClassify: true });
  assert.equal(r2.proposals.length, 0, "第二次不该再出重复提案");
  assert.equal(r2.entries, 0, "被去重跳过");
  const r3 = await runDream({ poolDir: pool, chat: stub, llmClassify: true, force: true });
  assert.equal(r3.proposals.length, 1, "force 可以强制重出");
  ok("去重：已有待审批提案的条目不再重复出（force 可覆盖）");
  rmSync(pool, { recursive: true, force: true });
}

// --- 模型失败 / 垃圾输出 / 空池（fail-soft：退回启发式，但仍要说清楚）----------
{
  const pool = seedPool([{ text: "任何一条长度足够的内容，用于验证模型失败时的退化行为。" }]);
  const r1 = await runDream({ poolDir: pool, chat: async () => { throw new Error("模型挂了"); }, llmClassify: true });
  assert.equal(r1.ok, true, "模型失败不该让整个分诊失败（退回启发式）");
  assert.ok(r1.errors.some((e) => e.includes("模型挂了")), `必须报出模型失败：${r1.errors.join("；")}`);
  assert.equal(r1.proposals.length, 1, "仍给出可审的提案");
  assert.ok(r1.proposals[0].body.length > 0, "正文退回原文（不空）");
  assert.ok(r1.proposals[0].reason.includes("兜底"), `理由要说明兜底：${r1.proposals[0].reason}`);

  // 垃圾输出：分类退回启发式；正文质量闸门拦下（不能把客套话写进 KB）
  const r2 = await runDream({ poolDir: pool, chat: async () => "我觉得挺好的呀", llmClassify: true, force: true });
  assert.equal(r2.ok, true, "垃圾输出也退化而不是崩");
  const kb = r2.proposals[0];
  assert.equal(kb.body, "任何一条长度足够的内容，用于验证模型失败时的退化行为。", "正文不合格式 → 退回原文（不是那句客套话）");
  assert.ok(r2.errors.some((e) => e.includes("不合格式") || e.includes("退回启发式")), `要说明原因：${r2.errors.join("；")}`);

  // 空池：不算错
  const empty = mkdtempSync(join(tmpdir(), "mpi-dream-empty-"));
  const r3 = await runDream({ poolDir: empty, chat: async () => "x" });
  assert.equal(r3.ok, true);
  assert.equal(r3.entries, 0);
  ok("模型失败/垃圾输出/空池：退回启发式 + 正文质量闸门，错误显式回报");
  rmSync(pool, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
}

// --- dry-run 与正文预算 ------------------------------------------------------
{
  const pool = seedPool([{ text: "预览用的条目，长度要足以通过内容过滤。" }, { text: "第二个条目，用来验证正文预算是否按顺序消耗。" }]);
  const ids = listEntries(pool).entries.map((e) => e.id);
  const stub = async (sys) => (sys.includes("记忆分诊器") ? ids.map((id) => line(id, [true, false, true, false, false, true])).join("\n") : "正文");

  const dry = await runDream({ poolDir: pool, chat: stub, llmClassify: true, dryRun: true });
  assert.equal(dry.proposals.length, 2, "dry-run 仍返回提案内容");
  assert.equal(listProposals(pool).proposals.length, 0, "dry-run 不写盘");

  // 正文预算 1 → 第二条的正文用原文兜底，且理由里说明
  const lim = await runDream({ poolDir: pool, chat: stub, llmClassify: true, maxBodies: 1 });
  assert.equal(lim.proposals.length, 2);
  const fallback = lim.proposals.filter((p) => p.reason.includes("预算"));
  assert.equal(fallback.length, 1, "恰好一条走兜底");
  assert.ok(fallback[0].body.length > 0, "兜底也有正文（原文），不是空白");
  assert.ok(lim.errors.some((e) => e.includes("正文")), "兜底要在 errors 里说明");
  ok("dry-run 不落盘；正文预算用尽时用原文兜底并在理由与错误里说明");
  rmSync(pool, { recursive: true, force: true });
}

// --- 累加器 ----------------------------------------------------------------
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-dream-acc-"));
  assert.equal(loadConsolidation(pool).remaining, CONSOLIDATION_THRESHOLD, "初始满额");
  assert.equal(consolidationDue(pool), false);
  let triggered = false;
  for (let i = 0; i < 25; i++) triggered = noteIngest(pool, 7).triggered || triggered;
  assert.equal(triggered, true, "25 条 7 分（175）应触发");
  assert.equal(consolidationDue(pool), true, "状态落盘后仍记得到点");
  assert.ok(existsSync(join(pool, ".consolidation.json")), "状态文件存在");
  const reloaded = loadConsolidation(pool);
  assert.equal(reloaded.remaining <= 0, true, "重启后仍记得该跑巩固");
  assert.equal(reloaded.writes, 25);

  const settled = markConsolidated(pool, "manual");
  assert.equal(settled.remaining, CONSOLIDATION_THRESHOLD, "跑完后重置");
  assert.equal(consolidationDue(pool), false);

  writeFileSync(join(pool, ".consolidation.json"), "{ 坏 JSON", "utf8");
  assert.equal(loadConsolidation(pool).remaining, CONSOLIDATION_THRESHOLD, "坏状态文件退回满额");
  ok("累加器：触发/持久化/重置/坏文件兜底（重启不丢分）");
  rmSync(pool, { recursive: true, force: true });
}

// --- 工具函数 --------------------------------------------------------------
{
  assert.equal(lessonFileFor("随便", "---\nlesson: ext-self-contained\n---\n"), "ExtSelfContained.md");
  assert.equal(lessonFileFor("No frontmatter", "正文"), "NoFrontmatter.md");
  assert.equal(titleFromEntry("提交前必须等用户确认再 push。这是第二句。"), "提交前必须等用户确认再 push");
  assert.equal(titleFromEntry("```\ncode\n```\n真正的内容"), "真正的内容", "代码块不参与标题");
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson("无 JSON"), null);
  ok("工具函数：lesson 文件名、标题生成（去代码块）、JSON 提取");
}

// --- 文件名与标题：真机踩过的怪名（108108.md / MemoryMemory.md / MemoryZve.md）----
{
  const { lessonSlug, lessonHint } = await import("../src/main/memory-promote.ts");
  // 纯数字词丢掉（旧实现把标题里的两个日期抓出来拼成 108108.md）
  assert.equal(lessonSlug("2026 10 08 的采购计划", "01ABCDEFGH"), "Lesson-ABCDEFGH", "纯数字不进文件名（回退到提示+id）");
  // 重复词去重（Memory/Memory → 只留一个）
  assert.equal(lessonSlug("Memory Memory approve reject", "01ABCDEFGH"), "MemoryApproveReject", "重复词去重");
  // 词数封顶 5
  assert.equal(lessonSlug("Aaa Bbb Ccc Ddd Eee Fff Ggg", "01ABCDEFGH").split(/(?=[A-Z])/).filter(Boolean).length, 5, "词数封顶 5");
  // 中文标题（没有可用 ASCII 词）→ 主题提示 + 稳定短 id（可读、唯一）
  assert.equal(lessonSlug("用户的检索需求", "01ABCDEFGH", "ToolQuirk"), "ToolQuirk-ABCDEFGH", "中文标题回退成可读提示+id");
  assert.equal(lessonHint({ tags: ["tool-quirk"] }), "ToolQuirk");
  assert.equal(lessonHint({ tags: ["insight"] }), "Insight");
  assert.equal(lessonHint({ type: "procedural", tags: [] }), "Procedure");
  assert.equal(lessonHint({ tags: [], type: "semantic" }), "Lesson");
  ok("lesson 文件名：丢纯数字、去重复词、封顶 5 词；中文标题回退成可读提示+id");

  // 标题不在词中间下刀
  assert.equal(clipTitle("短标题"), "短标题", "不超长时原样返回");
  const clipped = clipTitle("/memory 的检索目前是字面的，因为扩展受自包含限制无法读取 zvec 索引，所以只能做字面匹配");
  assert.ok(clipped.endsWith("…"), "超长要带省略号");
  assert.ok(!clipped.includes("zve…") || clipped.includes("读取…"), `不该把 zvec 切成 zve：${clipped}`);
  assert.ok(clipTitle("在该项目中，涉及扩展文件或主进程改动时必须完整重启 dev（Ctrl+C 后重跑）").length <= 37, "截断长度受控");
  ok("标题截断：不切碎词（zvec 不会变成 zve）");

  // 与既有 lesson 去重（真机：提案目标 MemoryApproveMemoryRejectMemo.md 在 KB 里已存在）
  const dir = mkdtempSync(join(tmpdir(), "mpi-lessons-"));
  const CH_NL = String.fromCharCode(10);
  writeFileSync(join(dir, "SomeLesson.md"), "# 已有教训" + CH_NL + CH_NL + "这条内容已经写进知识库了，不该再出提案。" + CH_NL, "utf8");
  assert.match(String(existingLessonFor(dir, "Some Lesson", "这条内容已经写进知识库了，不该再出提案。", "01ABCDEFGH")), /SomeLesson\.md/, "同内容应命中既有 lesson");
  assert.equal(existingLessonFor(dir, "完全不同的话题 FullWidth", "另一件毫不相干的事情，讲的是别的模块。", "01ABCDEFGH"), null, "无关内容不误判");
  assert.match(String(existingLessonFor(dir, "Some Lesson", "x", "01ABCDEFGH")), /同名/, "同 slug 直接命中");
  rmSync(dir, { recursive: true, force: true });
  ok("既有 lesson 去重：同内容/同名命中（真机重复提案已消除）");
}

console.log(`\ntest:dream 全部通过（${n} 项）`);
