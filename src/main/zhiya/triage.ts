/**
 * 分诊（去向判定）+ 巩固累加器 + 提案形状 —— P3 核心纯逻辑
 *
 * 规格来源：MEMORY-MODEL.md §3（决策树）、§5（巩固触发与 N=3 晋升）。
 * 这一层刻意不碰 fs、不碰 LLM、不碰 electron：决策树就是几个布尔值的路由，
 * 布尔值由 dream 的模型判断（或人工在面板上点），路由必须可测、可复现。
 */
import { PROMOTE_RECURRENCE, type PoolEntry } from "./pool";

// ---------------------------------------------------------------------------
// 一、去向判定（决策树）
// ---------------------------------------------------------------------------

/** 四个出口（MEMORY-MODEL.md 图二）。 */
export type Outlet =
  | "inject" // 出口① 常驻注入：画像 / 约定 / 工作空间
  | "kb" // 出口② 知识库：项目 lessons
  | "now" // 出口③ 当前任务：HANDOFF / changelog / 待办
  | "archive"; // 出口④ 归档（**不是删除**）

/**
 * 决策树要问的问题。前四个是必答（叶子判定必需），后面按路径才用到。
 * 命名与文档 §3 图三的 Q1–Q6 一一对应。
 */
export interface TriageAnswers {
  /** Q1 现在还成立吗 */
  stillValid: boolean;
  /** Q2 是程序性的吗（「如果 X 就做 Y」，带触发器） */
  procedural?: boolean;
  /** Q3 跨会话长期有效吗 */
  crossSession?: boolean;
  /** Q4 当前任务还在进行吗 */
  activeTask?: boolean;
  /** Q5 每次会话都要用到吗 */
  everySession?: boolean;
  /** Q6 是本项目的知识吗 */
  projectKnowledge?: boolean;
}

export interface TriageResult {
  outlet: Outlet;
  /** 为什么落这个出口（写成一句话，会进提案供你审） */
  reason: string;
}

/**
 * 按文档决策树路由。顺序是刻意的：
 *   先问过期（过期的没必要往后走）→ 再问程序性（唯一带触发器、直接进约定）→ 最后按频率分流。
 */
export function triage(a: TriageAnswers): TriageResult {
  // Q1 过期/不成立 → 归档
  if (!a.stillValid) {
    return { outlet: "archive", reason: "已不成立/过期 → 归档（归档≠删除，可找回）" };
  }
  // Q2 程序性（if-then）→ 常驻注入（协作约定条目）
  if (a.procedural) {
    return { outlet: "inject", reason: "程序性（如果 X 就做 Y）→ 常驻注入，写成协作约定条目" };
  }
  // Q3 不跨会话 → 只在当前任务里
  if (!a.crossSession) {
    return a.activeTask
      ? { outlet: "now", reason: "只对本轮任务有效且任务仍在进行 → 当前任务出口" }
      : { outlet: "archive", reason: "不跨会话且任务已结束 → 归档" };
  }
  // Q3 是（长期有效）→ 按「每次会话都要用吗」分流
  if (a.everySession) {
    return { outlet: "inject", reason: "长期有效且每次会话都要用 → 常驻注入" };
  }
  return a.projectKnowledge
    ? { outlet: "kb", reason: "长期有效、非每次都需 → 本项目知识 → 进项目知识库 lessons/" }
    : { outlet: "inject", reason: "长期有效、跨项目通用 → 常驻注入（需你审批）" };
}

/** 出口 → 中文标签（日志与面板用）。 */
export const OUTLET_LABEL: Record<Outlet, string> = {
  inject: "① 常驻注入",
  kb: "② 知识库",
  now: "③ 当前任务",
  archive: "④ 归档",
};

// ---------------------------------------------------------------------------
// 二、晋升资格（N = 3）
// ---------------------------------------------------------------------------

/** 够格进入晋升流程的条目：在池里、且复现次数达到 N。 */
export function isPromotable(e: PoolEntry): boolean {
  return e.status === "inbox" && e.recurrence >= PROMOTE_RECURRENCE;
}

export interface DreamInput {
  /** 够格晋升的（复现 ≥3）—— 提案的第一优先级 */
  promotable: PoolEntry[];
  /** 其余待分诊的（高重要性但复现不足、或单纯积压的） */
  rest: PoolEntry[];
}

/**
 * 启发式判定（不看模型的默认路径）。
 *
 * 为什么默认走启发式：本机 qwen3.8-27b 对"逐条判断六题"这类任务**思考停不下来**——
 * 实测 8 条：max_tokens 2500 → 思考吃满、content 空；改 8000 → 112s 仍空；
 * `/no_think` 放 system 或 user、长提示或短提示都一样。既然它的正文生成能力没问题
 * （lesson 文档一次就写得很好），就把**判定**收回到可测的规则里，把 LLM 用在它擅长的地方。
 *
 * 想用模型判定（换了非思考型模型以后）→ zhiyaDreamLlmClassify / --llm-classify。
 */
export function heuristicAnswers(e: PoolEntry): TriageAnswers {
  const t = e.text;
  // 过期：明确写了不再成立（保守：只在写了字面信号时才判过期，不乱归档）
  const expired = /(已经?过期|不再适用|已废弃|已弃用|已经废止|no longer (valid|applies)|deprecated)/.test(t);
  // 跨会话：默认**长期有效**，只有写了任务局部标记才当短期。
  // 为什么反过来判：抽取模型给很多项目事实打了 temporal=present（“现在的状态”），
  // 但“现在的状态”≠“只对当下这一轮任务有用”——按 present 判短期会把项目知识全错分到“当前任务”。
  const taskLocal = /(本轮|这一轮|本次任务|当前任务|临时|先这样|暂时|待会儿|稍后处理)/.test(t);
  const crossSession = !taskLocal;
  // 程序性：必须有**触发器模式**（如果/一旦/每当…就，或「X 之前/之后必须 Y」）。
  // 只看"必须"太宽——技术事实里写"必须复用句柄"也会被当成规则（测试抳到过）。
  const triggerLike =
    /(如果|一旦|每当|当[^。；]{0,12}时)[^。；]{0,40}(就|则|必须|要|请|应)/.test(t) ||
    /[^。；]{0,14}(前|后|之前|之后)[^。；]{0,12}(必须|一律|要|请|应)/.test(t) ||
    /(禁止|不得|一律|总是|永远不要|千万不要)/.test(t) ||
    /\bif\b[^.。]{0,40}\b(then|must|always|never)\b/i.test(t);
  // 只有**跨项目**的规则才进全局协作约定：约定文件是所有项目共享的（persona/Agreement.md），
  // 项目内的操作习惯属于该项目知识 → 进 kb，不污染全局。
  const procedural = triggerLike && e.project === "global";
  return {
    stillValid: !expired,
    procedural,
    crossSession,
    activeTask: e.temporal === "present",
    // "每次会话都要用到"是个很强的断言：只有跨项目规则或字面写了"每次"才认，
    // 否则会有一堆条目挤进常驻注入（那些是 4000 字预算里最贵的位置）。
    everySession: /每次|每天|每个会话|所有项目|任何项目/.test(t),
    // 项目归属：池子的约定是 global 表示跨项目
    projectKnowledge: e.project !== "global",
  };
}

/**
 * 挑选 dream 要看的条目。
 * 排序刻意让 **够格的排前面**：模型上下文有限，"复现 3 次"是唯一有认知科学依据的硬资格，
 * 不该被一堆单次记录挤掉。
 */
export function dreamInput(entries: PoolEntry[], maxRest = 40): DreamInput {
  const live = entries.filter((e) => e.status === "inbox");
  const promotable = live.filter(isPromotable).sort((a, b) => b.recurrence - a.recurrence || b.importance - a.importance);
  const rest = live
    .filter((e) => !isPromotable(e))
    .sort((a, b) => b.importance - a.importance || (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, maxRest);
  return { promotable, rest };
}

// ---------------------------------------------------------------------------
// 三、巩固累加器（dream 何时跑）
// ---------------------------------------------------------------------------

/** 阈值依据见 MEMORY-MODEL.md §5：官方 importance_trigger_max = 150。 */
export const CONSOLIDATION_THRESHOLD = 150;

export interface ConsolidationState {
  /** 距离下次巩固还差多少分（每写入一条减该条的重要性）。 */
  remaining: number;
  /** 累计写入条数（自上次巩固以来）。 */
  writes: number;
  /** 累计消耗（= 阈值 - remaining，仅统计用）。 */
  consumed: number;
  /** 上次巩固时间（ISO），从未跑过为 null。 */
  lastRunAt: string | null;
  /** 上次巩固的触发方式：auto（分满）| manual（手动跑） */
  lastRunBy: "auto" | "manual" | null;
}

export function newConsolidation(): ConsolidationState {
  return { remaining: CONSOLIDATION_THRESHOLD, writes: 0, consumed: 0, lastRunAt: null, lastRunBy: null };
}

/**
 * 记账：写入一条记忆就扣掉它的重要性分数。
 * 用减法而不是累加，是因为"重要的记忆更快把阈值推满"——比按条数计更贴实际。
 * 纯函数：返回新状态，不改入参。
 */
export function debit(
  state: ConsolidationState,
  importance: number,
): { state: ConsolidationState; triggered: boolean } {
  const cost = Math.max(0, Math.min(10, Math.round(importance)));
  const remaining = state.remaining - cost;
  if (remaining > 0) {
    return {
      state: { ...state, remaining, writes: state.writes + 1, consumed: state.consumed + cost },
      triggered: false,
    };
  }
  // 到点：本次触发但**不在这里重置**——重置发生在巩固真正跑完之后，
  // 否则巩固失败会把分数白白吞掉（宁可重复触发，不可漏掉）。
  return {
    state: { ...state, remaining, writes: state.writes + 1, consumed: state.consumed + cost },
    triggered: true,
  };
}

/** 巩固跑完（或用户手动跑）后重置。 */
export function settle(state: ConsolidationState, by: "auto" | "manual", now: string): ConsolidationState {
  return { remaining: CONSOLIDATION_THRESHOLD, writes: 0, consumed: 0, lastRunAt: now, lastRunBy: by };
}

/** 该不该现在自动跑一次巩固。 */
export function dueForConsolidation(state: ConsolidationState): boolean {
  return state.remaining <= 0;
}

// ---------------------------------------------------------------------------
// 四、提案（dream 的产出）
// ---------------------------------------------------------------------------

export type ProposalKind = "promote-kb" | "promote-inject" | "promote-now" | "archive";
export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "failed";

export const KIND_LABEL: Record<ProposalKind, string> = {
  "promote-kb": "晋升 → 项目知识库 lessons/",
  "promote-inject": "晋升 → 常驻注入（画像/约定，需你合并）",
  "promote-now": "晋升 → 当前任务（HANDOFF/changelog/待办）",
  archive: "归档（归档≠删除）",
};

export const OUTLET_TO_KIND: Record<Outlet, ProposalKind> = {
  inject: "promote-inject",
  kb: "promote-kb",
  now: "promote-now",
  archive: "archive",
};

export interface Proposal {
  id: string;
  createdAt: string;
  kind: ProposalKind;
  status: ProposalStatus;
  /** 依据的池内条目 id（晋升是多条合并出来的，归档通常一条） */
  entries: string[];
  /** 去向判定时用到的出口（kind 由它推出，留档便于回溯） */
  outlet: Outlet;
  /** 分诊理由（人工判断是否合理的关键依据） */
  reason: string;
  /** 一句话标题（列表展示用） */
  title: string;
  /** 拟落的正文。kb 出口是完整 lesson 文档；inject/now 是要合并进去的段落 */
  body: string;
  /** 目标准则路径（kb 出口用；其它出口为 null） */
  target: string | null;
  /** 审批时间 */
  decidedAt: string | null;
  /** 执行结果或失败原因 */
  result: string | null;
}

/** 提案落盘路径：<池>/proposals/<id>.md（不分月——提案生命周期短，平铺更好翻）。 */
export function proposalFileName(id: string): string {
  return `${id}.md`;
}

const FM_KEYS = [
  "id",
  "created",
  "kind",
  "status",
  "outlet",
  "entries",
  "title",
  "target",
  "decidedAt",
  "result",
] as const;

/** 序列化：frontmatter（机器读）+ 理由与正文（人读 / git diff 审）。 */
export function serializeProposal(p: Proposal): string {
  const fm = [
    "---",
    `id: ${p.id}`,
    `created: ${p.createdAt}`,
    `kind: ${p.kind}`,
    `status: ${p.status}`,
    `outlet: ${p.outlet}`,
    `entries: ${p.entries.join(",")}`,
    `title: ${oneLine(p.title)}`,
    `target: ${p.target ?? ""}`,
    `decidedAt: ${p.decidedAt ?? ""}`,
    `result: ${p.result ? oneLine(p.result) : ""}`,
    "---",
  ].join("\n");
  return [
    fm,
    "",
    `# ${oneLine(p.title)}`,
    "",
    `> 去向：${OUTLET_LABEL[p.outlet]}（${KIND_LABEL[p.kind]}）`,
    `> 理由：${oneLine(p.reason)}`,
    `> 依据条目：${p.entries.join(" ") || "（无）"}`,
    p.target ? `> 目标：${p.target}` : null,
    "",
    p.body.trim(),
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** frontmatter 值必须是单行：换行会破坏解析（也避免注入伪造键）。 */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

export type ProposalParse = { ok: true; proposal: Proposal } | { ok: false; reason: string };

const KINDS: ProposalKind[] = ["promote-kb", "promote-inject", "promote-now", "archive"];
const STATUSES: ProposalStatus[] = ["pending", "approved", "rejected", "applied", "failed"];
const OUTLETS: Outlet[] = ["inject", "kb", "now", "archive"];

/** 解析提案。宽容读取、严格校验：缺关键字段就判坏，宁可不动也不猜。 */
export function parseProposal(raw: string): ProposalParse {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { ok: false, reason: "缺少 frontmatter" };
  const fm = new Map<string, string>();
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    fm.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const get = (k: (typeof FM_KEYS)[number]): string => fm.get(k) ?? "";
  const id = get("id");
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return { ok: false, reason: `id 非法：${id}` };
  const kind = get("kind") as ProposalKind;
  if (!KINDS.includes(kind)) return { ok: false, reason: `kind 非法：${kind}` };
  const status = get("status") as ProposalStatus;
  if (!STATUSES.includes(status)) return { ok: false, reason: `status 非法：${status}` };
  const outlet = get("outlet") as Outlet;
  if (!OUTLETS.includes(outlet)) return { ok: false, reason: `outlet 非法：${outlet}` };

  const rest = raw.slice(m[0].length);
  const reasonLine = /^>\s*理由：(.+)$/m.exec(rest)?.[1]?.trim() ?? "";
  const body = rest
    .replace(/^# .+$/m, "")
    .replace(/^>.*$/gm, "")
    .trim();

  return {
    ok: true,
    proposal: {
      id,
      createdAt: get("created"),
      kind,
      status,
      outlet,
      entries: get("entries") ? get("entries").split(",").map((s) => s.trim()).filter(Boolean) : [],
      reason: reasonLine,
      title: get("title") || "(无标题)",
      body,
      target: get("target") || null,
      decidedAt: get("decidedAt") || null,
      result: get("result") || null,
    },
  };
}
