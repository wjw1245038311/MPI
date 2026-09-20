/**
 * dream —— 周期分诊（P3 核心）
 *
 * 设计取舍（真机实测后改的，不是拍脑袋）：
 *   ✗ 最初让模型"归并主题 + 六问"，结果本地 qwen3.8-27b 把 max_tokens 全烧在思考上、
 *     content 返回空（4000 tokens / 66s → 0 字；12000 tokens / 198s → 0 字，实测两次）。
 *   ✓ 改为**逐条紧凑分类**（每行一条、竖线分隔）+ 提示词末尾 `/no_think`：
 *     8 条 30s、finish_reason=stop、输出规整可解析。
 *   ✗ 也不再让模型做"重复合并"——池子的摄入端已有判重累加（recurrence），
 *     重复本来就是同一个条目，让模型再合一次只是徒增幻觉面。
 *
 * 分工（关键：判断权不放错地方）：
 *   模型只回答**六个判断题**（语义判断，它擅长）；
 *   **路由**由 triage() 用代码执行（必须可复现、可测、可审计）。
 *
 * 产出永远是**提案**：不直接改池子、不直接改 KB。
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultMemoryModel } from "./memory-model";
import { listEntries, newId, type PoolEntry } from "./zhiya/pool";
import { listProposals, writeProposal } from "./zhiya/proposals";
import { OUTLET_TO_KIND, dreamInput, heuristicAnswers, notLessonMaterial, triage, type Proposal, type TriageAnswers } from "./zhiya/triage";
import { lessonHint, lessonSlug } from "./memory-promote";
import { lexicalSimilarity } from "./zhiya/pool";

export interface DreamDeps {
  poolDir: string;
  llmUrl?: string;
  llmModel?: string;
  /** 记忆模型密钥（走配置里的供应商时才有；本机 LM Studio 没有） */
  llmKey?: string;
  /** 记忆模型模式（调用方解析后传入；不传则按 llmUrl/环境变量推断） */
  mode?: "none" | "session" | "model";
  /** 模式说明（日志用，例如 "跟随主模型（默认模型 xxx/yyy）"） */
  modelDesc?: string;
  /** 注入对话函数（测试用）；默认走本地 LLM */
  chat?: (system: string, user: string, maxTokens: number) => Promise<string>;
  log?: (m: string) => void;
  /** 只分诊不落盘（预览） */
  dryRun?: boolean;
  /** 单次最多分诊多少条（默认 12；控时间） */
  maxEntries?: number;
  /** 单次最多生成几份正文（默认 6；每条一次模型调用） */
  maxBodies?: number;
  /** 每批分类多少条（默认 8，实测 30s/批） */
  batchSize?: number;
  /** 忽略"已有待审批提案"的去重（默认 false） */
  force?: boolean;
  /** 让模型做六题判定（默认 false：本机思考型模型在该任务上不可靠，见 triage.ts 注释） */
  llmClassify?: boolean;
  /** 条目本身没带 projectRoot 时的兜底项目根（老条目、CLI 从项目目录跑时用） */
  defaultProjectRoot?: string;
}

export interface DreamReport {
  ok: boolean;
  /** 参与分诊的条目数 */
  entries: number;
  /** 模型成功分类的条目数 */
  classified: number;
  proposals: Proposal[];
  errors: string[];
  ms: number;
}

// 默认端点/模型现在由 memory-model.resolveMemoryModel() 统一给出（设置里可改）

/**
 * 关掉思考模式：Qwen3 系在提示词末尾加 `/no_think` 才肯直接作答。
 * 实测：不加 → 思考 token 吃满预算、content 为空；加了 → 30s 出规整结果。
 */
const NO_THINK = "\n/no_think";

/**
 * 调本地模型。
 * @param allowReasoningFallback 允许把 reasoning_content 当答案（**正文生成绝不允许**：
 *   实测本机模型偶尔 content 为空，reasoning 里是"我打算怎么写"的规划文字——
 *   把它当 lesson 写进 KB 就是往知识库倒垃圾（真发生了一次，已加质量闸门 + 默认关掉兜底））。
 */
async function defaultChat(
  url: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  allowReasoningFallback = true,
  apiKey?: string,
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system + NO_THINK },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const j = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
  };
  const choice = j.choices?.[0];
  const msg = choice?.message;
  const content = (msg?.content || "").trim();
  const reasoning = (msg?.reasoning_content || "").trim();
  const out = content || (allowReasoningFallback ? reasoning : "");
  // 排障开关：MPI_MEMORY_DREAM_DEBUG=<文件路径> → 把模型原始输出追写到该文件。
  // 为什么需要："模型输出不符约定格式"这类问题，不看原始输出就只能瞎猜。
  const dbg = process.env.MPI_MEMORY_DREAM_DEBUG;
  if (dbg) {
    try {
      appendFileSync(
        dbg,
        `\n===== ${new Date().toISOString()} finish=${choice?.finish_reason} content=${(msg?.content || "").length} reasoning=${(msg?.reasoning_content || "").length} =====\n${out}\n`,
        "utf8",
      );
    } catch {
      /* 排障写不进去不影响主流程 */
    }
  }
  if (!out) throw new Error(`模型返回空内容（finish_reason=${choice?.finish_reason ?? "?"}）`);
  return out;
}

/** 从模型输出里抠出第一个完整 JSON 对象（模型爱加围栏和解释文字）。 */
export function extractJson(raw: string): unknown | null {
  const cleaned = raw.replace(/```json/gi, "```").replace(/```/g, "");
  const i = cleaned.indexOf("{");
  const j = cleaned.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(cleaned.slice(i, j + 1));
  } catch {
    return null;
  }
}

const CLASSIFY_SYSTEM = `你是记忆分诊器：对每条记忆回答六个判断题。

输出格式：每行一条，**第一列必须是输入的 id，原样照抄**，共七列、用竖线分隔。
不要表头、不要编号、不要任何其它文字。

示例（id 必须在最前，不许省略 id 列）：
01M2Z67GRTRJ10TV0Z270XJQ6Y|true|false|true|false|false|true

七列含义（照顺序判）：
1. id：照抄输入条目的 id（26 位字母数字，不许改写、不许省略）
2. stillValid：这条记忆现在还成立吗？（技术已过时、事实已改变 → false）
3. procedural：是"如果 X 就做 Y"的操作规则吗？
4. crossSession：跨会话长期有效吗？（只对当时那一轮任务有用 → false）
5. activeTask：当前任务还在进行吗？（crossSession=false 时才需要关心）
6. everySession：每次会话都要用到吗？
7. projectKnowledge：是本项目特有的知识吗？（跨项目通用的做法 → false）

只输出 true/false，小写。输入几条就输出几行。`;

const LESSON_SYSTEM = `你把一条记忆写成项目经验文档（lesson），给后续的编程 agent 读。

必须用这个格式（frontmatter 键名照抄）：

---
lesson: <kebab-case 短名>
module: <源码模块，如 src/main>
tags: [<3-5 个标签>]
source: zhiya
guard-strength: directive
applies-when: [<什么情况下该想起这条>]
---

# <Title>

## Symptom

<现象：出错时你看到什么>

## Root Cause

<根因：为什么会出现>

## Fix

<怎么修>

## Guard

<以后怎么避免：给出会改变行动的硬性指令，不要写"要注意"这种废话>

## Evidence

- <证据：文件路径 / 函数名 / 命令>

只输出文档本身，不要解释、不要代码围栏包裹整篇。中文内容照原文保留。`;

const SHORT_SYSTEM = `你把一条记忆改写成可直接粘贴进长期内容的文字。

要求：
- 只输出正文，不要解释、不要标题、不要代码围栏。
- 3-6 行，祈使句，写"该怎么做"而不是"曾经发生过什么"。
- 保留原文里的具体标识符（文件路径、函数名、命令）。`;

function entryLine(e: PoolEntry, idx: number): string {
  return `${e.id}|${idx}｜项目=${e.project}｜复现=${e.recurrence}｜${e.text.replace(/\s+/g, " ").slice(0, 300)}`;
}

/**
 * 解析"每条一行"的分类结果。
 *
 * 真机踩过的坑：本机模型会**省掉 id 列**只给六个布尔（提示词里写清了也不管）。
 * 所以两条路：
 *   ① 严格：第一列是合法 id → 按 id 对号入座
 *   ② 兜底：一行 id 都没认出来、但值行数 == 条目数 → **按输入行序对齐**（并明确报警）
 * 为什么允许兜底：输入顺序是我们给的，批内位置对齐是确定的；
 * 但必须报警——默默按位置对齐，一旦模型微调行序就会把判断按到错条目上。
 */
export function parseClassifyLines(
  raw: string,
  batch: { id: string }[],
): { answers: Map<string, TriageAnswers>; errors: string[] } {
  const answers = new Map<string, TriageAnswers>();
  const errors: string[] = [];
  const validIds = new Set(batch.map((e) => e.id));
  const valueLines: string[][] = [];

  const toAnswers = (cols: string[]): TriageAnswers => {
    const b = (i: number): boolean => cols[i].startsWith("true") || cols[i] === "yes";
    return {
      stillValid: b(0),
      procedural: b(1),
      crossSession: b(2),
      activeTask: b(3),
      everySession: b(4),
      projectKnowledge: b(5),
    };
  };

  for (const line of raw.split(/\r?\n/)) {
    // ⚠️ 只去真正的列表前缀：不能把开头的数字一起吃掉——ULID 就是数字开头（例如 01M2Z67…）
    const t = line.trim().replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "");
    if (!t.includes("|")) continue;
    const cols = t.split("|").map((c) => c.trim());

    if (cols.length === 7 && validIds.has(cols[0])) {
      answers.set(cols[0], toAnswers(cols.slice(1).map((c) => c.toLowerCase())));
      continue;
    }
    // 六个布尔（模型省了 id 列）→ 先攒着，最后按行序对齐
    if (cols.length === 6 && cols.every((c) => /^(true|false|yes|no)$/i.test(c))) {
      valueLines.push(cols.map((c) => c.toLowerCase()));
      continue;
    }
    if (cols.length < 6) errors.push(`行字段不足，已跳过：${t.slice(0, 60)}`);
    // 其余（含幻觉 id）静默丢：字段齐但不是我们要的条目
  }

  if (!answers.size && valueLines.length === batch.length) {
    batch.forEach((e, i) => answers.set(e.id, toAnswers(valueLines[i])));
    errors.push("模型省略了 id 列，已按输入行序对齐（若模型打乱了行序，判断会错位）");
  } else if (!answers.size && valueLines.length) {
    errors.push(`模型输出 ${valueLines.length} 行、输入 ${batch.length} 条，行数不匹配，无法按序对齐，本批跳过`);
  }
  return { answers, errors };
}

/** 从条目正文里取一个短标题（非 kb 出口用；kb 出口用 lesson 文档里的标题）。 */
export function titleFromEntry(text: string, max = 36): string {
  // 去掉代码块与行首标记后，取**第一段非空**文字。
  // ⚠️ 不能只取 split 后的第 0 段：代码块被移除后第 0 段可能是空白，
  //    再回退到原文就会把围栏也当成标题（测试抳到过）。
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[#>*\-\s]+/gm, "")
    .trim();
  const first = cleaned
    .split(/[。！？\n.!?]/)
    .map((s) => s.trim())
    .find(Boolean);
  return clipTitle(first || cleaned || "（无标题）", max);
}

/**
 * 按长度截断标题，但**不在词中间下刀**。
 *
 * 真机问题（2026-09-20）：直接 `slice(0, 36)` 会把 "…读取 zvec" 截成 "…读取 zve"、
 * "重启 dev（Ctrl+C" 截成半截 —— 标题读不通，还会顺着文件名生成传给 lesson 文件名
 * （`MemoryZve.md` 就是这么来的）。
 * 做法：超长时在 max 附近**回退到最近的边界**（空格/标点/中英交界），并补省略号。
 */
export function clipTitle(raw: string, max = 36): string {
  const t = raw.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);
  let cut = -1;
  // 从 max-2 往前找：**不能把"头部末尾"当边界**（head[max-1] 后面没字符，
  // 一开始写成了 head.length-1，于是永远在最后一位"假命中边界"，等于没回退）
  for (let i = Math.min(head.length, max) - 2; i >= Math.max(0, max - 12); i--) {
    const c = head[i];
    if (/\s/.test(c) || "，。；：、,;:（(【[/|—-]".includes(c) || isWordChar(c) !== isWordChar(head[i + 1])) {
      cut = i;
      break;
    }
  }
  if (cut < 0) {
    // 实在没边界：至少不要把一个 ASCII 词切一半
    let j = head.length - 1;
    while (j > 0 && isWordChar(head[j])) j--;
    cut = j > 0 && head.length - j <= 6 ? j : head.length - 1;
  }
  const trimmed = head.slice(0, cut + 1).replace(/[\s，。；：、,;:（(【[/|—-]+$/, "");
  return `${trimmed}…`;
}

/**
 * 正文质量闸门：不合格就当生成失败（退回原文）。
 * 为什么需要：模型偶尔会把无关文本（甚至分类说明、客套话）当正文交回来，
 * 直接写进 lesson 会把 KB 污染成垃圾——宁可退回原文让人看见材料。
 */
export function looksLikeBody(kind: Proposal["kind"], body: string): boolean {
  if (kind === "promote-kb") {
    // lesson 文档必须有 frontmatter（或至少两个 ## 小节）
    return /^---\s*\nlesson:/m.test(body) || (body.match(/^##\s+/gm) ?? []).length >= 2;
  }
  return body.trim().length >= 20;
}

/** 阶段二：按出口生成正文。 */
async function buildBody(
  chat: (s: string, u: string, m: number) => Promise<string>,
  kind: Proposal["kind"],
  entry: PoolEntry,
): Promise<string> {
  if (kind === "promote-kb") return (await chat(LESSON_SYSTEM, entry.text, 3000)).trim();
  return (await chat(SHORT_SYSTEM, entry.text, 1200)).trim();
}

/**
 * 跑一次分诊：读池 → 分批分类 → 代码路由 → 逐条生成正文 → 写提案。
 * 全程不改池子、不改 KB；失败只记 errors，不抛（后台任务）。
 */
export async function runDream(deps: DreamDeps): Promise<DreamReport> {
  const t0 = Date.now();
  const log = deps.log ?? (() => {});
  const errors: string[] = [];
  const maxEntries = deps.maxEntries ?? 12;
  const maxBodies = deps.maxBodies ?? 6;
  const batchSize = Math.max(1, deps.batchSize ?? 8);
  // 记忆模型：调用方（memory-ops / CLI）负责按设置解析后传进来；
  // 没传就用纯默认（环境变量，或"不调模型"）——这样本模块不依赖 electron，可在纯 node 里测。
  //   none    —— 不调模型：正文用原文（提案仍产出，人能看到材料）
  //   session —— 跟随主模型（由调用方解析成具体端点）
  //   model   —— 指定供应商+模型
  const fallback = defaultMemoryModel();
  const mode = deps.mode ?? (deps.chat || deps.llmUrl || deps.llmModel ? "model" : fallback.mode);
  const modelOff = mode === "none" && !deps.chat;
  const llmUrl = deps.llmUrl ?? fallback.url;
  const llmModel = deps.llmModel ?? fallback.model;
  const llmKey = deps.llmKey ?? fallback.key;
  if (modelOff) log("[memory] dream：未设置记忆模型 → 不调模型，正文用原文");
  else if (deps.modelDesc) log(`[memory] dream 使用记忆模型：${deps.modelDesc}`);
  const chat =
    deps.chat ??
    ((s: string, u: string, m: number) => defaultChat(llmUrl, llmModel, s, u, m, true, llmKey));
  const bodyChat =
    deps.chat ??
    ((s: string, u: string, m: number) =>
      // 正文：content 为空就失败——拿 reasoning 当正文会把"思考过程"写进知识库
      defaultChat(llmUrl, llmModel, s, u, m, false, llmKey));

  const { entries } = listEntries(deps.poolDir);
  const { promotable, rest, belowBar } = dreamInput(entries, maxEntries);
  let pool = [...promotable, ...rest];

  // 去重/尊重人的决定：
  //   ① 已有待审批/已批准提案覆盖的条目 → 这轮不再重复出提案；
  //   ② **被人拒绝过的条目 → 不再自动重提**（真机抓到：拒绝后下一轮又原样冒出来，
  //      因为拒绝只改提案状态、条目仍是 inbox）。想重提用 --force。
  if (!deps.force) {
    const all = listProposals(deps.poolDir).proposals;
    // 覆盖 = 已经**处理过**的（待批 / 已批 / 已落地 / 已拒绝）。
    // ⚠️ applied 必须算：inject / now 出口落地时**故意不改条目状态**（"不假标记为已晋升"），
    // 若不算 applied，这两类出口会每轮 dream 都重新冒出来（真机算过：17 份 inject 会无限重提）。
    // failed 不算（那是真失败，值得下一轮重试并再次暴露给人看）。
    const covered = new Set(
      all.filter((p) => ["pending", "approved", "applied", "rejected"].includes(p.status)).flatMap((p) => p.entries),
    );
    const rejected = new Set(all.filter((p) => p.status === "rejected").flatMap((p) => p.entries));
    const before = pool.length;
    pool = pool.filter((e) => !covered.has(e.id));
    const covSkipped = before - pool.length;
    const before2 = pool.length;
    pool = pool.filter((e) => !rejected.has(e.id));
    const rejSkipped = before2 - pool.length;
    if (covSkipped) log(`[memory] dream：跳过 ${covSkipped} 条已有提案的条目`);
    if (rejSkipped) log(`[memory] dream：跳过 ${rejSkipped} 条已被你拒绝过的条目（想重提加 --force）`);
  }
  // 内容层过滤：个人事务 / 任务推进记录不进 KB 候选（见 notLessonMaterial 注释里的真机背景）
  {
    const before = pool.length;
    const skipped: string[] = [];
    pool = pool.filter((e) => {
      const why = notLessonMaterial(e);
      if (why) skipped.push(`${e.id.slice(-6)}：${why}`);
      return !why;
    });
    if (skipped.length) log(`[memory] dream：跳过 ${before - pool.length} 条不适合当 lesson 的条目（${skipped.slice(0, 3).join("；")}${skipped.length > 3 ? " …" : ""}）`);
  }
  if (belowBar) log(`[memory] dream：${belowBar} 条单次记录未达晋升门槛（复现 ≥2 或带知识标签），留在池里不出提案`);
  pool = pool.slice(0, maxEntries);

  if (!pool.length) {
    return {
      ok: true,
      entries: 0,
      classified: 0,
      proposals: [],
      errors: ["没有待分诊的条目（可能都已有提案）"],
      ms: Date.now() - t0,
    };
  }

  // none 模式：连"让模型判定"都不做（llmClassify 也要模型）
  const useLlmClassify = deps.llmClassify === true && !modelOff;

  // ---- 阶段一：判定（默认启发式；可选让模型判）----
  //
  // 默认走 heuristicAnswers：本机思考型模型在该任务上思考停不下来（实测见 triage.ts 注释）。
  // 开 deps.llmClassify（配置 zhiyaDreamLlmClassify / --llm-classify）才调模型。
  const answers = new Map<string, TriageAnswers>();
  if (!useLlmClassify) {
    for (const e of pool) answers.set(e.id, heuristicAnswers(e));
    log(`[memory] dream：用启发式规则判定 ${answers.size} 条（未调用模型）`);
  } else {
    for (let i = 0; i < pool.length; i += batchSize) {
      const batch = pool.slice(i, i + batchSize);
      const userMsg = batch.map((e, k) => entryLine(e, i + k + 1)).join("\n");
      try {
        const raw = await chat(CLASSIFY_SYSTEM, userMsg, 2500);
        const parsed = parseClassifyLines(raw, batch);
        errors.push(...parsed.errors);
        if (!parsed.answers.size) {
          errors.push(`第 ${Math.floor(i / batchSize) + 1} 批没解析出有效行，退回启发式判定`);
          for (const e of batch) answers.set(e.id, heuristicAnswers(e));
          continue;
        }
        for (const [id, a] of parsed.answers) answers.set(id, a);
        const missing = batch.filter((e) => !parsed.answers.has(e.id));
        if (missing.length) {
          errors.push(`模型漏答 ${missing.length} 条，已用启发式规则补上`);
          for (const e of missing) answers.set(e.id, heuristicAnswers(e));
        }
      } catch (err) {
        errors.push(`第 ${Math.floor(i / batchSize) + 1} 批调用失败（${(err as Error).message}），退回启发式判定`);
        for (const e of batch) answers.set(e.id, heuristicAnswers(e));
      }
    }
  }
  const classified = [...answers.keys()].length;
  if (!classified) {
    return { ok: false, entries: pool.length, classified: 0, proposals: [], errors: [...errors, "一条都没分类成功"], ms: Date.now() - t0 };
  }

  // ---- 阶段二：按出口生成正文 + 写提案 ----
  const proposals: Proposal[] = [];
  let bodies = 0;
  const byId = new Map(pool.map((e) => [e.id, e]));
  // 优先级：够格晋升的、重要性高的先给正文预算
  const ordered = [...answers.keys()].sort((a, b) => {
    const ea = byId.get(a)!;
    const eb = byId.get(b)!;
    return (eb.recurrence - ea.recurrence) || (eb.importance - ea.importance);
  });

  for (const id of ordered) {
    const e = byId.get(id);
    if (!e) continue;
    const routed = triage(answers.get(id)!);
    const kind = OUTLET_TO_KIND[routed.outlet];

    // 既有 lesson 去重（真机问题：提案目标 MemoryApproveMemoryRejectMemo.md 在 KB 里已存在，
    // 真跑就会撞已有文件/写出重复内容）。命中即不出提案，只在报告里说明。
    if (kind === "promote-kb") {
      const root0 = e.projectRoot ?? deps.defaultProjectRoot ?? null;
      const dir0 = root0 ? join(root0, ".alexandria", "knowledge", "lessons") : null;
      const dup = dir0 ? existingLessonFor(dir0, titleForDedupe(e), e.text, e.id) : null;
      if (dup) {
        errors.push(`跳过 ${e.id.slice(-6)}：KB 已有同一教训（${dup}）`);
        continue;
      }
    }

    let body = "";
    let reason = routed.reason;
    if (kind === "archive") {
      // 归档不需要正文（归档≠删除，文件本身留档）
    } else if (modelOff) {
      // 不调模型：正文用原文，提案照出（人能看到材料）
      body = e.text;
      reason += "｜未设置记忆模型：正文用原文（设置「跟随主模型」或指定模型后可由 /memory-dream 生成 lesson）";
    } else if (bodies < maxBodies) {
      try {
        body = await buildBody(bodyChat, kind, e);
        bodies++;
      } catch (err) {
        errors.push(`正文生成失败（${e.id.slice(-6)}）：${(err as Error).message}`);
      }
      // 质量闸门：模型偶尔会把无关文本当正文交回来（闸门不通过就退回原文，宁可粗糙不可乱写）
      if (body.trim() && !looksLikeBody(kind, body)) {
        errors.push(`正文不合格式（${e.id.slice(-6)}），已用原文兜底`);
        body = "";
      }
      if (!body.trim()) {
        body = e.text; // 兜底：把原文摆出来，人至少能看到材料
        reason += "｜正文生成失败，已用原文兜底，可重跑 dream 覆盖";
      }
    } else {
      body = e.text;
      reason += "｜本轮正文生成预算已用尽（正文=原文），下一次分诊会补齐";
      // 也报出来：批次内谁走了兜底要看得见（否则“为什么这条 lesson 是原文”无从查起）
      errors.push(`正文预算用尽（${e.id.slice(-6)}）：本条正文为原文，下一次分诊会补`);
    }

    const title =
      kind === "promote-kb" ? (/^#\s+(.+)$/m.exec(body)?.[1]?.trim() || titleFromEntry(e.text)) : titleFromEntry(e.text);

    const root = e.projectRoot ?? deps.defaultProjectRoot ?? null;
    const proposal: Proposal = {
      id: newId(),
      createdAt: new Date().toISOString(),
      kind,
      status: "pending",
      outlet: routed.outlet,
      entries: [e.id],
      reason: `${reason}｜复现 ${e.recurrence} 次｜重要性 ${e.importance}`,
      title,
      body,
      target:
        kind === "promote-kb" && root
          ? join(root, ".alexandria", "knowledge", "lessons", lessonFileFor(title, body, lessonHint(e), e.id))
          : null,
      decidedAt: null,
      result: null,
    };
    if (!deps.dryRun) {
      try {
        writeProposal(deps.poolDir, proposal);
      } catch (err) {
        errors.push(`写入提案失败：${(err as Error).message}`);
        continue;
      }
    }
    proposals.push(proposal);
  }

  log(`[memory] dream 完成：${pool.length} 条 → 分类 ${classified} → ${proposals.length} 份提案（${(Date.now() - t0) / 1000}s）`);
  return { ok: true, entries: pool.length, classified, proposals, errors, ms: Date.now() - t0 };
}

/**
 * 从 lesson 正文的 frontmatter 里取 lesson 名做文件名；取不到就用标题。
 * 具体命名规则统一在 `lessonSlug`（promote 落盘时用的是同一份），这里不再各写一套——
 * 真机踩过：两处文件名生成不一致，提案预览的名字和实际落盘的名字不一样。
 */
export function lessonFileFor(title: string, body: string, hint?: string, id = "00000000"): string {
  const name = /^lesson:\s*(.+)$/m.exec(body)?.[1]?.trim();
  return `${lessonSlug(name || title, id, hint)}.md`;
}

/** 既有 lesson 查重：同 slug，或与某篇既有 lesson 正文高度相似。 */
export function existingLessonFor(dir: string, title: string, text: string, id: string): string | null {
  const slug = lessonSlug(title, id, "Lesson");
  const same = join(dir, `${slug}.md`);
  if (existsSync(same)) return `${slug}.md（同名）`;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f: string) => f.endsWith(".md"));
  } catch {
    return null;
  }
  const needle = text.replace(/\s+/g, "");
  for (const n of names) {
    let body = "";
    try {
      body = readFileSync(join(dir, n), "utf8");
    } catch {
      continue;
    }
    const hay = body.replace(/\s+/g, "");
    if (needle.length > 20 && hay.includes(needle.slice(0, 20))) return `${n}（正文已含该内容）`;
    if (lexicalSimilarity(text, body) >= 0.9) return `${n}（正文高度相似）`;
  }
  return null;
}

/** 查重用的标题（与提案标题保持同样的取法，避免两处不一致）。 */
function titleForDedupe(e: PoolEntry): string {
  return titleFromEntry(e.text);
}
