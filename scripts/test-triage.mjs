/**
 * 分诊核心测试（P3-a）—— 决策树、N=3 资格、巩固累加器、提案序列化
 *
 * 这里测的是"规格是否被忠实实现"：每条断言都对应 MEMORY-MODEL.md §3/§5 的一行。
 * 运行：npm run test:triage
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const {
  triage,
  heuristicAnswers,
  isPromotable,
  dreamInput,
  newConsolidation,
  debit,
  settle,
  dueForConsolidation,
  CONSOLIDATION_THRESHOLD,
  OUTLET_TO_KIND,
  serializeProposal,
  parseProposal,
} = await import("../src/main/zhiya/triage.ts");
const { newId } = await import("../src/main/zhiya/pool.ts");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

// --- 一、决策树：把文档 §3 的每条分支都走一遍 --------------------------------
// Q1 不成立 → 归档（且优先级最高：过期的不该往后走）
assert.equal(triage({ stillValid: false, procedural: true, crossSession: true }).outlet, "archive");
ok("Q1 已过期 → 归档（压过程序性判断）");

// Q2 程序性 → 常驻注入
assert.equal(triage({ stillValid: true, procedural: true }).outlet, "inject");
ok("Q2 程序性（if-then）→ 常驻注入");

// Q3 不跨会话 + 任务进行中 → 当前任务；任务结束 → 归档
assert.equal(triage({ stillValid: true, crossSession: false, activeTask: true }).outlet, "now");
assert.equal(triage({ stillValid: true, crossSession: false, activeTask: false }).outlet, "archive");
assert.equal(triage({ stillValid: true, crossSession: false }).outlet, "archive", "没答 activeTask 当任务已结束");
ok("Q3 不跨会话：任务进行中 → 当前任务；否则 → 归档");

// Q3 跨会话 → Q5 每次都用到 → 常驻注入；否则 Q6 本项目知识 → KB，跨项目 → 注入
assert.equal(triage({ stillValid: true, crossSession: true, everySession: true }).outlet, "inject");
assert.equal(
  triage({ stillValid: true, crossSession: true, everySession: false, projectKnowledge: true }).outlet,
  "kb",
);
assert.equal(
  triage({ stillValid: true, crossSession: true, everySession: false, projectKnowledge: false }).outlet,
  "inject",
);
ok("Q5/Q6 跨会话：每次都用到 → 注入；项目内 → KB；跨项目通用 → 注入");

// 每个出口映射到提案类型；出口与 kind 必须一一对应（面板/执行器都依赖它）
assert.deepEqual(OUTLET_TO_KIND, { inject: "promote-inject", kb: "promote-kb", now: "promote-now", archive: "archive" });
ok("四个出口 ↔ 四种提案类型一一对应");

// --- 二、N=3 晋升资格 --------------------------------------------------------
const entry = (over = {}) => ({
  id: newId(),
  createdAt: new Date().toISOString(),
  type: "semantic",
  temporal: "retrospective",
  importance: 6,
  relevance: 0.6,
  recurrence: 1,
  project: "MPI",
  source: "test",
  status: "inbox",
  promotedTo: null,
  tags: [],
  text: "示例条目",
  evidence: [],
  ...over,
});

assert.equal(isPromotable(entry({ recurrence: 2 })), false, "复现 2 次还不够");
assert.equal(isPromotable(entry({ recurrence: 3 })), true, "复现 3 次够格");
assert.equal(isPromotable(entry({ recurrence: 5, status: "promoted" })), false, "已晋升过的不再重复处理");
ok("N=3：复现 ≥3 且在池内才够格晋升");

const mixed = [
  entry({ recurrence: 3, importance: 5, text: "够格但重要性一般" }),
  entry({ recurrence: 7, importance: 9, text: "够格且重要" }),
  entry({ recurrence: 1, importance: 10, text: "重要但只出现一次" }),
  entry({ recurrence: 1, importance: 2, text: "琐事" }),
  entry({ recurrence: 4, status: "promoted", text: "已晋升" }),
];
const di = dreamInput(mixed, 10);
assert.deepEqual(
  di.promotable.map((e) => e.text),
  ["够格且重要", "够格但重要性一般"],
  "够格的按复现次数优先排序",
);
assert.deepEqual(
  di.rest.map((e) => e.text),
  ["重要但只出现一次", "琐事"],
  "不够格的按重要性排序，且排除已晋升的",
);
ok("dreamInput：够格的排前面，其余按重要性，已晋升的不再进上下文");

// --- 三、巩固累加器 ----------------------------------------------------------
let st = newConsolidation();
assert.equal(st.remaining, CONSOLIDATION_THRESHOLD, "初始就是满额 150");
assert.equal(dueForConsolidation(st), false, "满额时不该触发");

// 重要记忆更快推满阈值：10 条 5 分 → 50 分；再 20 条 → 到点
let triggered = false;
for (let i = 0; i < 30; i++) {
  const r = debit(st, 5);
  st = r.state;
  triggered = triggered || r.triggered;
}
assert.equal(triggered, true, "30 条 5 分应触发（150 分阈值）");
assert.equal(dueForConsolidation(st), true, "触发后处于待跑状态");

// 触发但未跑完 → 状态不重置（宁可重复触发，不可漏掉）
const before = st;
assert.equal(before.remaining <= 0, true, "到点后仍是负/零，靠 settle 重置");
st = settle(before, "manual", "2026-09-20T00:00:00.000Z");
assert.equal(st.remaining, CONSOLIDATION_THRESHOLD, "跑完后重置满额");
assert.equal(st.lastRunBy, "manual");
assert.equal(dueForConsolidation(st), false);
ok("累加器：按重要性扣分、到点触发、跑完才重置（失败不吞分）");

// 高分条目更快到点：10 条 10 分 = 100，再加 5 条 = 150
let st2 = newConsolidation();
for (let i = 0; i < 15; i++) st2 = debit(st2, 10).state;
assert.equal(dueForConsolidation(st2), true, "15 条 10 分同样到点（重要更快推满）");
ok("累加器：重要的记忆更快把阈值推满（15 条 10 分 vs 30 条 5 分）");

// 边界：0 分、超范围分数不破坏记账
assert.equal(debit(newConsolidation(), 0).state.remaining, 150, "0 分不扣");
assert.equal(debit(newConsolidation(), 99).state.remaining, 140, "越界分数被夹到 10");


// --- 启发式判定（默认路径，不依赖模型）--------------------------------------
{
  const mk = (over) => ({
    id: newId(), createdAt: new Date().toISOString(), type: "semantic", temporal: "retrospective",
    importance: 7, relevance: 0.7, recurrence: 1, project: "MPI", projectRoot: join(tmpdir(), "mpi-fake-project"),
    source: "t", status: "inbox", promotedTo: null, tags: [], text: "", evidence: [], recurrences: [], warnings: [], path: null,
    ...over,
  });
  const outletOf = (over) => triage(heuristicAnswers(mk(over))).outlet;

  // 项目内的技术事实 → 知识库（不是"当前任务"：temporal=present 不等于只对本轮有效）
  assert.equal(outletOf({ text: "zvec 的 ZVecOpen 带 FTS 要 208ms，必须复用句柄。", temporal: "present" }), "kb");
  ok("启发式：项目技术事实（含 present）→ 知识库，不会被当成「只对本轮有效」");

  // 跨项目规则 → 常驻注入（约定）
  assert.equal(outletOf({ text: "提交前必须等用户确认再 push。", project: "global", temporal: "prospective" }), "inject");
  // 项目内的操作规则 → 知识库（约定文件是所有项目共享的，不该塞项目私事）
  assert.equal(outletOf({ text: "/memory-forget 执行前必须二次确认。", project: "MPI" }), "kb");
  ok("启发式：跨项目规则 → 注入；项目内规则 → 知识库（不污染全局约定）");

  // 任务局部标记 → 当前任务
  assert.equal(outletOf({ text: "本轮临时决定：先跑测试再打包。", temporal: "present" }), "now");
  // 明确过期 → 归档
  assert.equal(outletOf({ text: "这条做法已废弃，不再适用。" }), "archive");
  ok("启发式：任务局部标记 → 当前任务；明确过期 → 归档");

  // 只看"必须"不算程序性（否则技术事实会被错分到约定）
  assert.equal(heuristicAnswers(mk({ text: "这里必须注意缓存。" })).procedural, false);
  assert.equal(heuristicAnswers(mk({ text: "如果模型返回空内容，就退回原文。", project: "global" })).procedural, true);
  ok("启发式：程序性必须有触发器模式（只看「必须」不算）");
}

// --- 四、提案序列化往返 ------------------------------------------------------
const p = {
  id: newId(),
  createdAt: new Date().toISOString(),
  kind: "promote-kb",
  status: "pending",
  outlet: "kb",
  entries: [newId(), newId()],
  reason: "长期有效、非每次都需 → 本项目知识",
  title: "扩展自包含：不能 import 本仓模块",
  body: "## Symptom\n\n扩展引用本仓模块后加载失败。\n\n## Guard\n\n扩展只能自包含。\n",
  target: ".alexandria/knowledge/lessons/ExtSelfContained.md",
  decidedAt: null,
  result: null,
};
const round = parseProposal(serializeProposal(p));
assert.equal(round.ok, true, `序列化后应能解析回来：${round.ok ? "" : round.reason}`);
assert.equal(round.proposal.id, p.id);
assert.equal(round.proposal.kind, "promote-kb");
assert.equal(round.proposal.status, "pending");
assert.deepEqual(round.proposal.entries, p.entries, "条目 id 列表往返一致");
assert.equal(round.proposal.reason, p.reason, "理由往返一致（人审的关键依据）");
assert.ok(round.proposal.body.includes("## Guard"), "正文往返一致");
assert.equal(round.proposal.target, p.target);
ok("提案序列化往返：id/kind/status/entries/理由/正文/目标 全部一致");

// 换行注入不能伪造 frontmatter 键（标题里塞 \n kind: archive）
const evil = { ...p, title: "标题\nkind: archive\nstatus: applied" };
const evilRound = parseProposal(serializeProposal(evil));
assert.equal(evilRound.ok, true);
assert.equal(evilRound.proposal.kind, "promote-kb", "换行注入无法改掉 kind");
assert.equal(evilRound.proposal.status, "pending", "换行注入无法改掉 status");
assert.ok(evilRound.proposal.title.includes("kind: archive"), "注入内容被当作普通标题文本保留");
ok("提案 frontmatter 抗注入：标题里的换行不会伪造出键");

// 坏输入：非法 id / 未知 kind / 缺 frontmatter 一律判坏，不瞎猜
assert.equal(parseProposal("没有 frontmatter 的正文").ok, false);
assert.equal(parseProposal(serializeProposal(p).replace(p.id, "不是ULID")).ok, false, "非法 id 判坏");
assert.equal(parseProposal(serializeProposal(p).replace("kind: promote-kb", "kind: whatever")).ok, false, "未知 kind 判坏");
ok("提案解析：坏输入判坏而不是猜（缺 frontmatter/非法 id/未知 kind）");

console.log(`\ntest:triage 全部通过（${n} 项）`);
