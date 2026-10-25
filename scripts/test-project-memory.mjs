/**
 * 项目记忆（L2）测试
 *
 * 覆盖两件事：
 *   1. 挖簇的核心判据（主题锚过滤 / 证据门槛 / 人工成果不被覆盖 / root 归一分组）；
 *   2. 落盘 + 面板快照 + 编辑批准（runProjectDigest → buildProjectSnapshot → updateProjectRule）。
 *
 * 不碰网络：embedding 由本文件注入一个确定性的 bigram 哈希向量（相近文本 → 相近向量），
 * 所以 `npm test` 在没有 llama-server 的机器上也能跑。
 *
 * 运行：npm run test:projectmemory
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const pm = await import("../src/main/zhiya/project-memory.ts");
const panel = await import("../src/main/memory-panel.ts");
const { newId } = await import("../src/main/zhiya/pool.ts");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

/**
 * 确定性假 embedding：按**语义主体**给标签向量（先匹配者优先）。
 *
 * 为什么不用 bigram 哈希：实测那玩意儿把「与锚句同义的改写」只算到 0.55~0.6，
 * 而「同主题但话题不同」的句子也在 0.4~0.5 —— 区分度不够，测不出锚过滤到底有没有用。
 * 这里直接按语义主体给正交方向，让「同主题 = 同方向」「不同主题 = 正交」，
 * 测试才是确定性的。真实 bge 的分布见 project-memory.ts 的 MIN_COSINE 注释。
 */
const TAG_RULES = [
  [/测试|套件|typecheck/i, "test"],
  [/发版|打包|分发|Seafile|中继/i, "release"],
  [/重启|重新构建|开发服务器|src\/main|ipc\.ts/i, "restart"],
];
const DIM = 64;
function tagIndex(tag) {
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.codePointAt(0)) % DIM;
  return h;
}
function fakeEmbed(texts) {
  return texts.map((t) => {
    const s = String(t);
    const v = new Array(DIM).fill(0);
    let hit = false;
    // 先匹配者优先：模拟「这句话的主体是什么」
    for (const [re, tag] of TAG_RULES) {
      if (re.test(s)) {
        v[tagIndex(tag)] += 1;
        hit = true;
        break;
      }
    }
    if (!hit) {
      // 无标签：用整句哈希给一个方向，保证非零向量
      let h = 0;
      for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % DIM;
      v[h] = 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

function entry(root, text, extra = {}) {
  return {
    id: newId(),
    createdAt: extra.createdAt ?? "2026-10-01T10:00:00+08:00",
    type: "procedural",
    temporal: "retrospective",
    importance: 6,
    relevance: 0.7,
    recurrence: 1,
    project: extra.project ?? "Demo",
    projectRoot: root,
    source: "test",
    status: "inbox",
    promotedTo: null,
    tags: extra.tags ?? [],
    text,
    evidence: [],
    recurrences: [],
    warnings: [],
    path: null,
  };
}

// ---------------------------------------------------------------------------
console.log("\n[1] 路径归一与 slug");
{
  assert.equal(pm.normalizeRoot("E:\\MyWorkspace\\Project\\MPI"), "e:/MyWorkspace/Project/MPI");
  assert.equal(pm.normalizeRoot("E:/MyWorkspace/Project/MPI/"), "e:/MyWorkspace/Project/MPI");
  assert.equal(pm.normalizeRoot(null), null);
  // Windows 大小写不敏感：两种写法必须是同一个键
  assert.equal(pm.rootKeyOf("E:\\MyWorkSpace\\Work"), pm.rootKeyOf("e:/myworkspace/work"));
  assert.equal(pm.slugForRoot("E:\\MyWorkspace\\Project\\MPI"), pm.slugForRoot("e:/myworkspace/project/mpi"));
  ok("反斜杠 / 尾斜杠 / 盘符大小写都归一，同一项目只有一个分组键");
}

// ---------------------------------------------------------------------------
console.log("\n[2] 教训信号过滤");
{
  assert.equal(pm.isLessonEntry(entry("E:/x", "修改 ipc.ts 后必须重启 dev 才生效")), true);
  assert.equal(pm.isLessonEntry(entry("E:/x", "新增了一个设置面板")), false);
  assert.equal(pm.isLessonEntry(entry("E:/x", "随便一句", { tags: ["insight"] })), true);
  ok("必须/不要/踩坑 等信号词与 insight 标签都能进候选，纯功能描述进不去");
}

// ---------------------------------------------------------------------------
console.log("\n[3] leader 聚类");
{
  const ids = ["a", "b", "c"];
  const vecs = new Map([
    ["a", [1, 0, 0]],
    ["b", [0.98, 0.02, 0]],
    ["c", [0, 1, 0]],
  ]);
  const clusters = pm.leaderCluster(ids, vecs, 0.9);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].length, 2);
  ok("相近向量并簇，正交向量各成一簇");
}

// ---------------------------------------------------------------------------
console.log("\n[4] 挖簇：锚过滤 + 证据门槛 + 分组");
{
  const ROOT = "E:\\MyWorkspace\\Project\\Demo";
  const entries = [
    // restart 主题：三条同义表述（应聚成一条规则）
    entry(ROOT, "修改 ipc.ts 后必须重启 dev 才生效，不重启等于没修"),
    entry(ROOT, "改了主进程代码后必须重启开发服务器，界面刷新不生效"),
    entry(ROOT, "改完 src/main 必须重新构建并重启开发服务器"),
    // 关键词命中「重启」且带教训信号（「不要再」），但语义主体是测试 → 只有锚过滤能挡
    entry(ROOT, "重启后测试套件全部通过，不要再跑全量测试"),
    // release 主题：只有一条 → 证据不足
    entry(ROOT, "发版时本地打包并分发到 Seafile 与中继，不等云端构建"),
    // 噪声：不带教训信号
    entry(ROOT, "新增了一个设置面板"),
    // 另一个项目根（大小写不同的同一路径）→ 应与上面同组
    entry("e:/myworkspace/project/demo", "重启开发服务器以后才生效，不要只刷新页面"),
  ];
  const { rules, stats } = await pm.digestProjectRules({ entries, minEvidence: 2 }, { embed: fakeEmbed });
  const restart = rules.find((r) => r.topic === "restart");
  assert.ok(restart, "应挖出 restart 规则");
  assert.equal(
    restart.evidenceCount,
    4,
    `restart 应只收 4 条（3 条 + 大小写路径那条；偏题的「测试」那条被锚过滤掉），实得 ${restart.evidenceCount}`,
  );
  assert.equal(rules.filter((r) => r.topic === "release").length, 0, "单条记录不该成规则");
  assert.equal(stats.groups, 1, "大小写不同的同一路径应归成一组");
  assert.equal(restart.status, "draft");
  assert.ok(restart.title.length > 0 && restart.body.length > 0, "草稿要有标题与正文");
  ok(`锚过滤后 restart 有 ${restart.evidenceCount} 条证据；发版单条被丢弃（${stats.droppedSmall} 个主题证据不足）`);
}

// ---------------------------------------------------------------------------
console.log("\n[5] 已有规则的 status / 人工正文不被覆盖");
{
  const ROOT = "E:\\MyWorkspace\\Project\\Demo";
  const entries = [
    entry(ROOT, "修改 ipc.ts 后必须重启 dev 才生效，不重启等于没修"),
    entry(ROOT, "改了主进程代码后必须重启开发服务器，界面刷新不生效"),
    entry(ROOT, "改完 src/main 必须重新构建并重启开发服务器"),
  ];
  const prev = {
    id: newId(),
    root: "e:/MyWorkspace/Project/Demo",
    project: "Demo",
    topic: "restart",
    title: "我手写的标题",
    body: "我手写的正文",
    sources: [],
    evidenceCount: 1,
    firstAt: "",
    lastAt: "",
    status: "approved",
    targetRel: "AGENTS.md",
    edited: true,
    createdAt: "2026-09-01T00:00:00+08:00",
    updatedAt: "2026-09-01T00:00:00+08:00",
    path: null,
  };
  const { rules } = await pm.digestProjectRules({ entries, existing: [prev], minEvidence: 2 }, { embed: fakeEmbed });
  const r = rules.find((x) => x.topic === "restart");
  assert.equal(r.id, prev.id, "同一 (root,topic) 应复用已有 id");
  assert.equal(r.title, "我手写的标题");
  assert.equal(r.body, "我手写的正文");
  assert.equal(r.status, "approved");
  assert.ok(r.evidenceCount >= 3, "证据统计仍要刷新");
  ok("重算只刷新证据，批准状态与人工正文原样保留");
}

// ---------------------------------------------------------------------------
console.log("\n[6] 落盘 / 读回 / 面板快照 / 编辑与删除");
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-pm-"));
  const ROOT = "E:\\MyWorkspace\\Project\\Demo";
  const { entries } = (() => {
    const list = [
      entry(ROOT, "修改 ipc.ts 后必须重启 dev 才生效，不重启等于没修"),
      entry(ROOT, "改了主进程代码后必须重启开发服务器，界面刷新不生效"),
      entry(ROOT, "改完 src/main 必须重新构建并重启开发服务器"),
    ];
    return { entries: list };
  })();

  // runProjectDigest 走的是 listEntries(poolDir)，所以先把条目写成池子文件
  const { writeEntry } = await import("../src/main/zhiya/pool.ts");
  for (const e of entries) writeEntry(pool, e);

  const res = await panel.runProjectDigest(pool, { embed: fakeEmbed, minEvidence: 2 });
  assert.equal(res.ok, true);
  assert.ok(res.rules >= 1, `应落盘至少 1 条规则，实得 ${res.rules}`);

  const snap = panel.buildProjectSnapshot({ poolDir: pool });
  assert.equal(snap.stats.total, res.rules);
  assert.ok(snap.groups.length >= 1);
  const g = snap.groups[0];
  assert.equal(g.project, "Demo");
  assert.equal(g.targetRel, "AGENTS.md");
  assert.equal(g.targetExists, false, "目标文件不存在时应标记「将新建」");
  assert.ok(g.poolCount === 3, `组内应统计到 3 条原料，实得 ${g.poolCount}`);
  ok(`落盘 ${snap.stats.total} 条；快照按项目聚组，落点标记正确`);

  // 元信息
  const meta = panel.readDigestMeta(pool);
  assert.ok(meta && typeof meta.at === "string");
  ok("挖簇元信息（时间 / 条数 / embedding 降级）已记录");

  // 编辑 → edited=true
  const rule = snap.groups[0].rules[0];
  const up = panel.updateProjectRule(pool, rule.id, { title: "手改标题", body: "手改正文" });
  assert.equal(up.ok, true);
  const after = panel.buildProjectSnapshot({ poolDir: pool }).groups[0].rules.find((r) => r.id === rule.id);
  assert.equal(after.title, "手改标题");
  assert.equal(after.edited, true);
  assert.ok(existsSync(after.path), "编辑后文件应仍在");
  ok("编辑保存后 edited=true，文件已更新");

  // 批准
  const ap = panel.updateProjectRule(pool, rule.id, { status: "approved" });
  assert.equal(ap.ok, true);
  // 已批准不能直接删
  const del1 = panel.deleteProjectRuleFromPanel(pool, rule.id);
  assert.equal(del1.ok, false);
  ok("批准后删除被拒（要求先停用）");

  // 文件内容可读回
  const raw = readFileSync(after.path, "utf8");
  assert.ok(raw.includes("status: approved"));
  assert.ok(raw.includes("手改标题"));
  ok("落盘格式可被 parseRule 读回（frontmatter + # 标题 + 正文）");

  rmSync(pool, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n[7] 降级：没有 embedding 也能出结果（整主题一簇）");
{
  const ROOT = "E:\\MyWorkspace\\Project\\Demo";
  const entries = [
    entry(ROOT, "修改 ipc.ts 后必须重启 dev 才生效"),
    entry(ROOT, "改了主进程后必须重启开发服务器"),
  ];
  const { rules, stats } = await pm.digestProjectRules({ entries, minEvidence: 2 });
  assert.equal(stats.embedError, undefined);
  assert.ok(rules.some((r) => r.topic === "restart"));
  ok("无 embed 注入时退化为关键词整簇，不抛错");
}

console.log(`\n项目记忆测试通过：${n} 项\n`);
