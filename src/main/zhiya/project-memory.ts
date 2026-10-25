/**
 * 项目记忆（L2）—— 从记忆池流水（L1）里挖出「反复踩过的坑」，压成项目级规矩。
 *
 * 为什么要有这一层（2026-10-20 交接，实测数据）：
 *   - L1 里 98.4% 的条目 `recurrence === 1`（同义句 embedding 实测 cosine ≈ 0.709，
 *     而写入端判重阈值是 0.82 → 永远命中不了），所以「同一条重复 3 次才晋升」这条路走不通。
 *   - 但**不同表述的同一件事**在池子里很多：MPI 项目里「重启」相关 72 条、
 *     「发版」相关 240 条 —— 反复出现本身就是千锤百炼的证据。
 *   - 所以判重从「单条重复计数」改成「项目内主题成簇」：一个簇 = 一条经验，证据 = 簇内条目数。
 *
 * 三条纪律：
 *   1. **机器只负责发现「反复写过」，措辞由人定。** 草稿正文是抽取式的（取簇内最高分的一条），
 *      不做生成式摘要 —— 摘要会编，而经验要能回溯到原话。人在面板上润色 → `edited: true`。
 *   2. **集群门槛双闸。** 关键词先框主题（可解释），embedding 再归并（抓同义表述），
 *      且必须过「教训信号」过滤 —— 否则会把「手机端功能开发记录」整片聚成大坨。
 *   3. **不覆盖人工成果。** 已 `approved` / `edited` 的规则重算时只更新证据统计，正文原样保留。
 *
 * 本模块不碰 fs 之外的运行时依赖：embedding 由调用方注入（ipc 传 embedText），
 * 所以能直接单测（`scripts/test-project-memory.mjs`），不需要 llama-server。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { newId, nowIso, type PoolEntry } from "./pool";

// ---------------------------------------------------------------------------
// 常量（全部有实测依据，改前先看注释）
// ---------------------------------------------------------------------------

/** 池内的 L2 目录名（与 inbox/ archived/ proposals/ 平级）。 */
export const PROJECT_MEMORY_DIR = "project-memory";

/**
 * 成簇下限：同一主题至少要 N 条记录才算「反复」。
 * 取 5：低于 5 的要么是偶发，要么是同一件事被同一会话记了两次。
 */
export const MIN_EVIDENCE = 5;

/**
 * 语义归并阈值。**不要照抄写入端的 dedupeRelevance = 0.82**：
 * 实测「改完主进程必须重启 dev」vs「编辑 src/main 后要重启应用」cosine = 0.709，
 * 0.82 会把同义表述全判为不同。
 *
 * 取 0.60（2026-10-20 对 MPI 370 条教训候选实测的锚句相似度分布）：
 *   restart  max 0.799 / 中位 0.653 / ≥0.60 占 34/36
 *   release  max 0.697 / 中位 0.589 / ≥0.60 占 15/40
 *   test-scope max 0.816 / 中位 0.547 / ≥0.60 占 6/40
 * 0.68 会把 restart 砍掉一半（只剩 19 条），0.55 又会把「关键词命中但偏题」的放进来。
 */
export const MIN_COSINE = 0.6;

/** 每条规则最多挂多少条证据（其余只计数，避免 frontmatter 无限长）。 */
export const MAX_SOURCES = 40;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type RuleStatus = "draft" | "approved" | "muted";

export interface ProjectRule {
  /** ULID。 */
  id: string;
  /** 项目根（原样，供展示与落盘路径）。 */
  root: string;
  /** 项目名（目录名，或池里的 project 字段）。 */
  project: string;
  /** 主题 id（见 TOPICS）。 */
  topic: string;
  /** 一句话规则（人可改）。 */
  title: string;
  /** 要点正文（人可改，抽取式草稿）。 */
  body: string;
  /** 支撑这条规则的流水条目 id。 */
  sources: string[];
  /** 簇内记录数（可能大于 sources.length，超出部分不落盘）。 */
  evidenceCount: number;
  /** 证据时间跨度。 */
  firstAt: string;
  lastAt: string;
  /** draft=待审；approved=已批准（可注入）；muted=人工停用。 */
  status: RuleStatus;
  /** 注入落点（相对 root），默认 AGENTS.md。 */
  targetRel: string;
  /** 人改过正文 → 重算时不覆盖。 */
  edited: boolean;
  createdAt: string;
  updatedAt: string;
  /** 文件路径（未落盘为 null）。 */
  path: string | null;
}

export interface MemoryTopic {
  id: string;
  /** 人类可读主题名（面板上分组用）。 */
  label: string;
  /** 关键词框定：正文/标签命中任一即进候选。 */
  keywords: RegExp;
  /** 草稿标题（人再润色；刻意写成「规矩」而不是「描述」）。 */
  draftTitle: string;
  /**
   * 主题锚句：一句「这类经验规范长什么样」的描述，用来算 embedding 相似度。
   *
   * 为什么需要它（实测教训，2026-10-20）：只做 leader 聚类、用簇质心当参照，
   * 顺序扫会让质心被无关条目拖偏 —— 首轮跑出来 `[release] 证据 43` 的正文讲的是
   * tailscale 覆盖端口，跟发版毫无关系。锚句固定不动，只做「属于这个主题吗」的判据。
   */
  anchor: string;
}

/**
 * 主题表。排序 = 面板默认展示顺序；量级是 2026-10-20 对 MPI 1691 条实测的
 * 「命中条数 / 其中含教训信号词的比例」，留作调参依据。
 */
export const TOPICS: MemoryTopic[] = [
  {
    id: "restart",
    label: "改动生效 / 重启",
    keywords: /重启|restart-dev|Ctrl\+R|watcher|热更新|重新加载|重新构建/,
    draftTitle: "改了主进程 / preload / 扩展源码后必须重启 dev",
    anchor: "修改主进程或前端源码后必须重新构建并重启开发服务器，界面刷新不生效",
  },
  {
    id: "test-scope",
    label: "测试范围",
    keywords: /测试|typecheck|套件|回归|npm test/,
    draftTitle: "按爆炸半径选测试范围，不要反射性跑全量",
    anchor: "改动后按影响范围选择要跑的测试套件，局部改动不要每次都跑全量测试",
  },
  {
    id: "release",
    label: "发版分发",
    keywords: /发版|Seafile|中继|latest\.yml|npm run dist|publish-release|Release/,
    draftTitle: "发版不等 CI，本机出包后直接分发到中继 + Seafile",
    anchor: "发版时在本地打包安装包并分发到镜像服务器与文件服务器，不要等待云端构建",
  },
  {
    id: "shell-env",
    label: "执行环境 / shell",
    keywords: /Git Bash|PowerShell|POSIX|uv |pip |路径/,
    draftTitle: "唯一 shell 是 Git Bash，路径用 POSIX 形式",
    anchor: "命令统一在 Git Bash 里执行，路径写 POSIX 形式，Python 包管理用 uv 不用 pip",
  },
  {
    id: "network",
    label: "网络 / 代理 / 超时",
    keywords: /代理|proxy|超时|timeout|重试|重连|隧道|DERP/,
    draftTitle: "网络不稳要显式超时 + 重试，别让请求裸等",
    anchor: "网络请求要设置超时与失败重试，连接断开后自动重连而不是让请求一直等待",
  },
  {
    id: "image",
    label: "图片 / 附件",
    keywords: /图片|Vision|attachment|data:image|附件/,
    draftTitle: "图片走引用而不是每轮重发 base64",
    anchor: "图片以本地路径或引用标识传递，不要每一轮都重复发送 base64 图片数据",
  },
  {
    id: "ipc",
    label: "主进程 / IPC / preload",
    keywords: /ipc|preload|主进程|renderer|IPC/,
    draftTitle: "新增 IPC 要同步 preload 与类型定义",
    anchor: "新增主进程通信通道要同步更新预加载桥接与类型定义，否则渲染层调不到",
  },
  {
    id: "memory",
    label: "记忆池 / 知芽",
    keywords: /记忆池|晋升|提案|mem0|pool/,
    draftTitle: "记忆写入按双闸过滤，晋升走人工审批",
    anchor: "记忆写入按重要性与相关性双闸过滤，长期经验晋升为规则前要人工审批",
  },
  {
    id: "package",
    label: "打包 / 发行版",
    keywords: /PI_PACKAGE_DIR|piRuntimeVersion|bundle-runtime|requestSingleInstanceLock|单实例|打包/,
    draftTitle: "打包前核对运行时目录与版本号一致",
    anchor: "打包前核对运行时依赖目录与版本号一致，正在运行的发行版无法启动第二个实例做冒烟",
  },
  {
    id: "git",
    label: "提交 / 推送",
    keywords: /提交|commit|push/,
    draftTitle: "提交后不自动推送，先说明变更等待确认",
    anchor: "代码提交后不要自动推送到远端，先说明变更内容等待确认再推送",
  },
  {
    id: "mobile",
    label: "手机端",
    keywords: /android|Kotlin|gradle|mobile|手机/,
    draftTitle: "手机端改动只跑 Gradle 那套",
    anchor: "手机端代码改动只跑 Gradle 构建与单元测试，不要连带跑桌面端的全量测试",
  },
  {
    id: "remote",
    label: "远程 / PWA",
    keywords: /PWA|relay|远程|隧道|tailscale|Tailscale/,
    draftTitle: "远程链路优先走公网并发分片",
    anchor: "远程访问与文件传输优先走公网端口并发分片，隧道单链路吞吐低",
  },
  {
    id: "model",
    label: "模型 / 供应商",
    keywords: /LM Studio|模型|provider|令牌|token|授权码/,
    draftTitle: "模型与供应商配置要可解释、可回滚",
    anchor: "模型与供应商配置要能解释来源、能回滚，改坏了可以退回上一版",
  },
  {
    id: "context",
    label: "会话 / 上下文",
    keywords: /上下文|压缩|会话|历史/,
    draftTitle: "长会话要主动压缩，别等撞上限",
    anchor: "长会话的上下文要主动压缩或摘要，不要等到撞上下文上限才处理",
  },
  {
    id: "ui",
    label: "界面 / 面板",
    keywords: /面板|设置|抽屉|按钮|切换/,
    draftTitle: "界面问题先确认状态来源",
    anchor: "界面显示异常先确认真实状态来自哪里，不要只改渲染层",
  },
  {
    id: "kb",
    label: "知识库 / 文档",
    keywords: /知识库|alexandria|lessons|AGENTS\.md/,
    draftTitle: "经验要放在每次必读的位置",
    anchor: "经验要写在每次都会被读取的位置，而不是只写进可搜索的知识库",
  },
];

/**
 * 教训信号词：把「功能开发记录」和「踩坑经验」分开。
 * 实测 MPI 1691 条里只有 366 条命中（21%），按主题命中率差异很大
 * （重启 50%、代理 50% vs 界面 20%）—— 不过滤会把整片开发生涯记录聚成大坨。
 */
export const LESSON_SIGNAL =
  /踩坑|教训|根因|注意|必须|不能|不要|应该|记得|反复|再次|终于|原来|其实|修复|改成|改为|坑/;

/** 采集端约定的显式知识标签（与 triage.ts 的 KNOWLEDGE_TAGS 同义，这里不 import 以免循环）。 */
const KNOWLEDGE_TAGS = new Set(["insight", "tool-quirk", "correction"]);

// ---------------------------------------------------------------------------
// 路径规范化
// ---------------------------------------------------------------------------

/**
 * Windows 路径归一：反斜杠 → 正斜杠、去尾斜杠、盘符小写。
 * **不做整串小写**（保留展示可读性）；大小写不敏感的比较走 `rootKeyOf`。
 */
export function normalizeRoot(root: string | null | undefined): string | null {
  if (!root) return null;
  let p = String(root).trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p) return null;
  if (/^[A-Za-z]:\//.test(p)) p = p[0].toLowerCase() + p.slice(1);
  return p;
}

/** 分组键：Windows 路径大小写不敏感，整串小写。 */
export function rootKeyOf(root: string | null | undefined): string {
  const n = normalizeRoot(root);
  return n ? n.toLowerCase() : "";
}

/** L2 目录名：`<目录名>-<4 位 hash>`，同名项目不打架。 */
export function slugForRoot(root: string): string {
  const key = rootKeyOf(root) || "unbound";
  const name = (basename(key.replace(/\/+$/, "")) || "unbound").replace(/[^a-z0-9._-]+/g, "-");
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0xffff;
  return `${name}-${h.toString(16).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// 聚类
// ---------------------------------------------------------------------------

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return s / Math.sqrt(na * nb);
}

/**
 * Leader 聚类：顺序扫，与已有簇质心相似度 ≥ minCos 就并入（取最近的），否则自立一簇。
 * 选 leader 而不是 k-means：不需要预设 k、顺序稳定（结果可复现）、O(n·k) 够快。
 * 返回按簇大小降序的成员 id 列表。
 */
export function leaderCluster(ids: string[], vecs: Map<string, number[]>, minCos: number): string[][] {
  const clusters: { centroid: number[]; members: string[] }[] = [];
  for (const id of ids) {
    const v = vecs.get(id);
    if (!v?.length) continue;
    let best = -1;
    let bestSim = minCos;
    for (let i = 0; i < clusters.length; i++) {
      const sim = cosine(v, clusters[i].centroid);
      if (sim >= bestSim) {
        bestSim = sim;
        best = i;
      }
    }
    if (best >= 0) {
      const c = clusters[best];
      c.members.push(id);
      const n = c.members.length;
      for (let i = 0; i < c.centroid.length; i++) c.centroid[i] = (c.centroid[i] * (n - 1) + v[i]) / n;
    } else {
      clusters.push({ centroid: [...v], members: [id] });
    }
  }
  return clusters.map((c) => c.members).sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// 挖簇
// ---------------------------------------------------------------------------

export interface DigestDeps {
  /** 批量 embedding；缺省时跳过语义归并（只用关键词，结果更粗但不会失败）。 */
  embed?: (texts: string[]) => Promise<number[][]>;
  now?: () => string;
}

export interface DigestInput {
  entries: PoolEntry[];
  /** 已有规则（用于保留状态与人工编辑）。 */
  existing?: ProjectRule[];
  minEvidence?: number;
  minCosine?: number;
}

export interface DigestStats {
  /** 参与分组的分组数（项目根数）。 */
  groups: number;
  /** 教训候选条目数（过滤后）。 */
  candidates: number;
  /** 被判定的主题数（有候选的主题）。 */
  topicsHit: number;
  /** 成簇数（不含被丢弃的小簇）。 */
  clusters: number;
  /** 因证据不足被丢弃的主题数。 */
  droppedSmall: number;
  /** embedding 失败原因（非空表示降级为纯关键词）。 */
  embedError?: string;
}

export interface DigestResult {
  rules: ProjectRule[];
  stats: DigestStats;
}

/** 一条候选：条目 + 用于 embedding 的文本。 */
function candidateText(e: PoolEntry): string {
  const tags = (e.tags ?? []).join(" ");
  return `${e.text ?? ""} ${tags}`.replace(/\s+/g, " ").trim().slice(0, 600);
}

/** 是否含「教训」信号（决定它配不配当经验原料）。 */
export function isLessonEntry(e: PoolEntry): boolean {
  if ((e.tags ?? []).some((t) => KNOWLEDGE_TAGS.has(t))) return true;
  return LESSON_SIGNAL.test(e.text ?? "");
}

/** 抽取式正文：取原话，不生成；超长按句子截断。 */
export function excerpt(text: string, maxChars = 240): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf(". "));
  return (lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim() + "…";
}

/**
 * 选代表句。
 *
 * 首轮实测的教训：按 importance 挑代表句会挑到「这个项目最重要的一条记录」，
 * 而不是「这个主题最典型的一条」——所以有 embedding 时按**与锚句的相似度**挑，
 * 没有 embedding 时才退回 importance（关键词模式下的最佳可用信号）。
 */
function pickEvidence(
  entries: PoolEntry[],
  maxChars: number,
  anchorSim?: Map<string, number>,
): { main: PoolEntry; body: string } {
  const sorted = [...entries].sort((a, b) => {
    if (anchorSim) {
      const d = (anchorSim.get(b.id) ?? 0) - (anchorSim.get(a.id) ?? 0);
      if (d !== 0) return d;
    }
    return b.importance - a.importance || (a.createdAt < b.createdAt ? 1 : -1);
  });
  return { main: sorted[0], body: excerpt(sorted[0]?.text ?? "", maxChars) };
}

function emptyStat(now: string): DigestStats {
  return { groups: 0, candidates: 0, topicsHit: 0, clusters: 0, droppedSmall: 0 };
}

/**
 * 主入口：把 L1 流水挖成 L2 规则草稿。
 *
 * 纯函数（除 deps.embed 的网络调用）：不写盘，调用方决定怎么落。
 * 同 (root, topic) 已有规则时**保留**其 status / title / body / edited，只刷新证据统计。
 */
export async function digestProjectRules(input: DigestInput, deps: DigestDeps = {}): Promise<DigestResult> {
  const now = deps.now?.() ?? nowIso();
  const minEvidence = input.minEvidence ?? MIN_EVIDENCE;
  const minCosine = input.minCosine ?? MIN_COSINE;
  const existing = input.existing ?? [];
  const stats = emptyStat(now);

  // 1. 按项目根分组（root 为空的归到 unbound，用 project 名兜底）
  const groups = new Map<string, { root: string; project: string; entries: PoolEntry[] }>();
  for (const e of input.entries) {
    if (e.status !== "inbox" && e.status !== "promoted") continue;
    const root = normalizeRoot(e.projectRoot) ?? "";
    const key = rootKeyOf(root) || `project:${e.project || "unknown"}`;
    const g = groups.get(key) ?? { root, project: e.project || basename(root) || "unknown", entries: [] };
    g.entries.push(e);
    groups.set(key, g);
  }
  stats.groups = groups.size;

  const rules: ProjectRule[] = [];
  const existingByKey = new Map(existing.map((r) => [`${rootKeyOf(r.root)}::${r.topic}`, r]));

  for (const g of groups.values()) {
    // 2. 教训过滤：只要「踩过坑」的记录当原料
    const candidates = g.entries.filter(isLessonEntry);
    stats.candidates += candidates.length;
    if (!candidates.length) continue;

    for (const topic of TOPICS) {
      const hits = candidates.filter((e) => topic.keywords.test(candidateText(e)));
      if (!hits.length) continue;
      stats.topicsHit++;

      // 3. 锚句过滤 + 种子过滤（两道，缺一不可）
      //    锚句过滤：只留「属于这个主题」的，不受其他条目影响；
      //    种子过滤：以与锚最像的一条为种子再筛一遍，去掉仍然偏题的（如主题里混进来的子话题）。
      //    embedding 不可用时退化为整主题一簇（更粗，但仍可用）。
      let members: PoolEntry[] = hits;
      const anchorSim = new Map<string, number>();
      if (deps.embed) {
        try {
          const vecs = await deps.embed([topic.anchor, ...hits.map(candidateText)]);
          const anchorVec = vecs[0];
          const byId = new Map(hits.map((e, i) => [e.id, vecs[i + 1]]));
          if (anchorVec?.length) {
            for (const e of hits) {
              const v = byId.get(e.id);
              if (v?.length) anchorSim.set(e.id, cosine(v, anchorVec));
            }
            const onTopic = hits.filter((e) => (anchorSim.get(e.id) ?? 0) >= minCosine);
            if (onTopic.length) {
              const seed = pickEvidence(onTopic, 0, anchorSim).main;
              const seedVec = byId.get(seed.id);
              members = seedVec?.length
                ? onTopic.filter((e) => cosine(byId.get(e.id) ?? [], seedVec) >= minCosine)
                : onTopic;
            } else {
              members = [];
            }
          }
        } catch (err) {
          stats.embedError = (err as Error)?.message ?? String(err);
          members = hits;
        }
      }

      if (members.length < minEvidence) {
        stats.droppedSmall++;
        continue;
      }
      stats.clusters++;

      const sortedByTime = [...members].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      const { body } = pickEvidence(members, 240, anchorSim.size ? anchorSim : undefined);
      const key = `${rootKeyOf(g.root)}::${topic.id}`;
      const prev = existingByKey.get(key);
      const sources = members.map((m) => m.id).slice(0, MAX_SOURCES);

      rules.push({
        id: prev?.id ?? newId(),
        root: g.root || prev?.root || "",
        project: g.project,
        topic: topic.id,
        // 人工成果优先：改过就不覆盖
        title: prev?.edited ? prev.title : prev?.title ?? topic.draftTitle,
        body: prev?.edited ? prev.body : body,
        sources,
        evidenceCount: members.length,
        firstAt: sortedByTime[0]?.createdAt ?? now,
        lastAt: sortedByTime[sortedByTime.length - 1]?.createdAt ?? now,
        status: prev?.status ?? "draft",
        targetRel: prev?.targetRel ?? "AGENTS.md",
        edited: prev?.edited ?? false,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        path: prev?.path ?? null,
      });
    }
  }

  // 4. 已有但本次没挖到的规则：保留（人可能手工加的），排后面
  const touched = new Set(rules.map((r) => r.id));
  for (const prev of existing) if (!touched.has(prev.id)) rules.push(prev);

  rules.sort((a, b) => {
    const rank = (s: RuleStatus) => (s === "approved" ? 0 : s === "draft" ? 1 : 2);
    return rank(a.status) - rank(b.status) || b.evidenceCount - a.evidenceCount;
  });
  return { rules, stats };
}

// ---------------------------------------------------------------------------
// 序列化 / 读写
// ---------------------------------------------------------------------------

function q(v: string): string {
  return JSON.stringify(v);
}

export function serializeRule(r: ProjectRule): string {
  const fm = [
    "---",
    `id: ${q(r.id)}`,
    `root: ${q(r.root)}`,
    `project: ${q(r.project)}`,
    `topic: ${q(r.topic)}`,
    `status: ${r.status}`,
    `evidence: ${r.evidenceCount}`,
    `first_at: ${q(r.firstAt)}`,
    `last_at: ${q(r.lastAt)}`,
    `target: ${q(r.targetRel)}`,
    `edited: ${r.edited}`,
    `created_at: ${q(r.createdAt)}`,
    `updated_at: ${q(r.updatedAt)}`,
    `sources: [${r.sources.map(q).join(", ")}]`,
    "---",
    "",
    `# ${r.title}`,
    "",
    r.body.trim(),
    "",
  ];
  return fm.join("\n");
}

function scalar(raw: string): string {
  const s = raw.trim();
  if (s === "null" || s === "") return "";
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.replace(/^"|"$/g, "");
    }
  }
  return s;
}

/** 极简 frontmatter 解析（只认本模块写出的格式；未知行忽略）。 */
export function parseRule(raw: string, path: string | null = null): ProjectRule | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const head = raw.slice(3, end).split(/\r?\n/);
  const rest = raw.slice(end + 4).trim();
  const map = new Map<string, string>();
  for (const line of head) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const id = scalar(map.get("id") ?? "");
  if (!id) return null;
  const status = (scalar(map.get("status") ?? "draft") || "draft") as RuleStatus;
  const rawSources = map.get("sources") ?? "[]";
  let sources: string[] = [];
  try {
    sources = JSON.parse(rawSources.replace(/^\s*\[/, "[").replace(/\]\s*$/, "]"));
  } catch {
    sources = rawSources.replace(/[\[\]]/g, "").split(",").map((s) => scalar(s)).filter(Boolean);
  }
  // 正文：跳过 `# 标题` 行
  const lines = rest.split(/\r?\n/);
  let title = "";
  let bodyStart = 0;
  if (lines[0]?.startsWith("# ")) {
    title = lines[0].slice(2).trim();
    bodyStart = 1;
  }
  const body = lines.slice(bodyStart).join("\n").trim();
  return {
    id,
    root: normalizeRoot(scalar(map.get("root") ?? "")) ?? "",
    project: scalar(map.get("project") ?? ""),
    topic: scalar(map.get("topic") ?? ""),
    title,
    body,
    sources: Array.isArray(sources) ? sources.map(String) : [],
    evidenceCount: Number(map.get("evidence") ?? sources.length) || 0,
    firstAt: scalar(map.get("first_at") ?? ""),
    lastAt: scalar(map.get("last_at") ?? ""),
    status: status === "approved" || status === "muted" ? status : "draft",
    targetRel: scalar(map.get("target") ?? "AGENTS.md") || "AGENTS.md",
    edited: (map.get("edited") ?? "false").trim() === "true",
    createdAt: scalar(map.get("created_at") ?? ""),
    updatedAt: scalar(map.get("updated_at") ?? ""),
    path,
  };
}

/** 读全部规则（坏文件跳过，不让一条坏数据拖崩面板）。 */
export function listProjectRules(poolDir: string): { rules: ProjectRule[]; broken: { path: string; reason: string }[] } {
  const base = join(poolDir, PROJECT_MEMORY_DIR);
  const rules: ProjectRule[] = [];
  const broken: { path: string; reason: string }[] = [];
  if (!existsSync(base)) return { rules, broken };
  for (const slug of readdirSync(base)) {
    const dir = join(base, slug);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const p = join(dir, name);
      try {
        const r = parseRule(readFileSync(p, "utf8"), p);
        if (r) rules.push(r);
        else broken.push({ path: p, reason: "frontmatter 无法解析" });
      } catch (e) {
        broken.push({ path: p, reason: (e as Error).message });
      }
    }
  }
  return { rules, broken };
}

/** 落盘一条规则；返回路径。 */
export function writeProjectRule(poolDir: string, r: ProjectRule): string {
  const dir = join(poolDir, PROJECT_MEMORY_DIR, slugForRoot(r.root || r.project));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${r.id}.md`);
  writeFileSync(p, serializeRule(r), "utf8");
  return p;
}

/** 删除一条规则（仅草稿；已批准的要人先停用）。 */
export function deleteProjectRule(poolDir: string, r: ProjectRule): boolean {
  if (!r.path || !existsSync(r.path)) return false;
  unlinkSync(r.path);
  return true;
}

// ---------------------------------------------------------------------------
// 面板展示辅助
// ---------------------------------------------------------------------------

export interface ProjectGroupView {
  root: string;
  project: string;
  /** 该项目的规则（草稿在前，已批准按证据量）。 */
  rules: ProjectRule[];
  /** 待审草稿数。 */
  pending: number;
  /** 已批准数。 */
  approved: number;
  /** 注入落点（相对 root）。 */
  targetRel: string;
  /** 落点文件此刻是否存在。 */
  targetExists: boolean;
  /** 池子里属于该项目的流水条数（展示用，提示「还有多少原料」）。 */
  poolCount: number;
}

/** 按项目聚合，供面板渲染（面板只管画，不再做逻辑）。 */
export function groupRulesForPanel(rules: ProjectRule[], entries: PoolEntry[]): ProjectGroupView[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = rootKeyOf(e.projectRoot) || `project:${e.project || "unknown"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups = new Map<string, ProjectGroupView>();
  for (const r of rules) {
    const key = rootKeyOf(r.root) || `project:${r.project || "unknown"}`;
    const g =
      groups.get(key) ??
      ({
        root: r.root,
        project: r.project,
        rules: [],
        pending: 0,
        approved: 0,
        targetRel: r.targetRel,
        targetExists: false,
        poolCount: counts.get(key) ?? 0,
      } satisfies ProjectGroupView);
    g.rules.push(r);
    if (r.status === "draft") g.pending++;
    if (r.status === "approved") g.approved++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.rules.length - a.rules.length);
}
