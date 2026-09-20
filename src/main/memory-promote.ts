/**
 * 审批后的执行器（P3）—— 把"批准"变成磁盘上的事实
 *
 * 三个出口的执行方式：
 *   ① 常驻注入（inject）→ **不自动写**。它进的是画像/约定文件，是所有项目共享的长期注入源，
 *      自动改写风险太高；审批后输出建议文本，由用户自己合并（文档也要求"必须你审批"）。
 *   ② 知识库（kb）→ 写 `<项目>/.alexandria/knowledge/lessons/<Slug>.md`（alexandria 四级阶梯格式）。
 *      **不自动 commit**，留给你 git diff 审。同名文件已存在则跳过，绝不覆盖人写的内容。
 *   ③ 当前任务（now）→ 同样需要人工并入 HANDOFF/changelog/待办。
 *   ④ 归档（archive）→ 移到归档目录（归档≠删除）+ 索引移除。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/** 换行与多行正则写成常量：本仓多次被"多层转义把 \n 吃掉"坑过（见 lesson 教训） */
const SEP_NL = String.fromCharCode(10);
const RE_FM_LESSON = new RegExp("^---\\s*\\n[^]*?^lesson:", "m");
import { dirname, join } from "node:path";
import { listEntries, writeEntry, type PoolEntry } from "./zhiya/pool";
import { moveFileSafe } from "./memory-inbox";
import { setProposalResult, setProposalStatus } from "./zhiya/proposals";
import type { Proposal } from "./zhiya/triage";

export interface ApplyDeps {
  poolDir: string;
  /** 归档目录（默认按配置推导） */
  archiveDir?: string;
  /** 项目知识库 lessons 目录（kb 出口的落点） */
  kbLessonsDir?: string | null;
  index?: { upsert(entries: PoolEntry[]): Promise<void>; remove(ids: string[]): Promise<void> };
  archiveDirFor?: (poolDir: string) => string;
  log?: (m: string) => void;
}

export interface ApplyResult {
  ok: boolean;
  /** applied = 已落地；manual = 需人工合并；skipped = 无事可做；failed = 失败 */
  action: "applied" | "manual" | "skipped" | "failed";
  detail: string;
  /** 本次写出的文件（供 UI 展示 / git diff 定位） */
  files: string[];
}

/**
 * 标题 → PascalCase 文件名（与既有 lesson 命名一致：DevRestartAfterMainPreloadChange.md）。
 *
 * 真机踩过的坑（2026-09-20，中文记忆迁移后第一次分诊）：
 *   - 旧实现把所有 ASCII 词直接拼接，于是出现 `108108.md`（只从标题里抓出两个数字）、
 *     `MemoryMemory.md`（重复词）、`MemoryZve.md`（中文标题里只有零散英文词）这类怪名。
 * 现在的规则：
 *   1. **丢掉纯数字词**（日期、编号对文件名没意义）；
 *   2. **去重重复词**（Memory/Memory → 只留一个）；
 *   3. 词数封顶 5 个（文件名不该长到读不完）；
 *   4. 可用词不足（≤1 个）时，回退成 _可读的主题提示_ +
 *      条目 id 后 8 位（例：`ToolQuirk-1WJYRPC0.md`）——虽然不知道内容，
 *      至少一眼能看出"这是个工具怪癖陷阱"而不是一串数字。
 */
export function lessonSlug(title: string, fallbackId: string, hint?: string): string {
  const raw = (title.match(/[A-Za-z0-9]+/g) ?? [])
    .filter((w) => /[A-Za-z]/.test(w)) // 纯数字不要（日期/编号）
    .filter((w) => w.length > 1);
  const words: string[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue; // 重复词丢掉
    seen.add(key);
    words.push(w);
    if (words.length >= 5) break;
  }
  if (words.length <= 1) {
    // 中文标题（或英文词太少）→ 主题提示 + 稳定短 id，保证唯一且能识别类型
    const tag = (hint || "Lesson").replace(/[^A-Za-z]/g, "") || "Lesson";
    return `${tag}-${fallbackId.slice(-8)}`;
  }
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

/** 从条目的标签/类型推一个"主题提示"（文件名回退时用）。 */
export function lessonHint(e: { tags?: string[]; type?: string }): string {
  for (const t of e.tags ?? []) {
    if (t === "tool-quirk") return "ToolQuirk";
    if (t === "insight") return "Insight";
    if (t === "correction") return "Correction";
  }
  if (e.type === "procedural") return "Procedure";
  if (e.type === "episodic") return "Episode";
  return "Lesson";
}

function entryById(poolDir: string, id: string): PoolEntry | null {
  return listEntries(poolDir).entries.find((e) => e.id === id) ?? null;
}

/** 把条目标记为已晋升（status + promotedTo），文件原地重写（月份/ id 不变，路径不动）。 */
function markPromoted(poolDir: string, entries: PoolEntry[], target: string, log: (m: string) => void): string[] {
  const files: string[] = [];
  for (const e of entries) {
    try {
      const path = writeEntry(poolDir, { ...e, status: "promoted", promotedTo: target });
      files.push(path);
    } catch (err) {
      log(`[memory] 标记晋升失败（${e.id}）：${(err as Error).message}`);
    }
  }
  return files;
}

export async function applyProposal(p: Proposal, deps: ApplyDeps): Promise<ApplyResult> {
  const log = deps.log ?? (() => {});
  const { poolDir } = deps;
  const entries = p.entries.map((id) => entryById(poolDir, id)).filter((e): e is PoolEntry => !!e);

  // 条目全没了（例如已被归档/删除）：不算失败，但要说清楚
  if (p.entries.length > 0 && entries.length === 0) {
    setProposalStatus(poolDir, p.id, "failed", { result: "依据的池内条目已不存在" });
    return { ok: false, action: "skipped", detail: "依据的池内条目已不存在", files: [] };
  }

  // ---- 出口① 常驻注入 / 出口③ 当前任务：只给建议，不自动改共享文件 ----
  if (p.kind === "promote-inject" || p.kind === "promote-now") {
    const where = p.kind === "promote-inject" ? "画像/约定文件（persona/Agreement.md）" : "HANDOFF/changelog/待办";
    const detail = `已批准，需你人工并入${where}。建议文本见提案 ${p.id} 的正文。`;
    setProposalResult(poolDir, p.id, detail); // 状态保持 approved（等待人工合并）
    log(`[memory] 提案 ${p.id} 已批准（${p.kind}）：待人工合并`);
    return { ok: true, action: "manual", detail, files: [] };
  }

  // ---- 出口② 知识库：写 lesson 文件（alexandria 格式）----
  if (p.kind === "promote-kb") {
    // 优先用提案里写明的确切目标（dream 已按条目里的项目根解析好，人在提案里能看见）
    const slug = lessonSlug(p.title, p.id, lessonHint({ tags: [], type: undefined }));
    const path = p.target && p.target.toLowerCase().endsWith(".md")
      ? p.target
      : deps.kbLessonsDir
        ? join(deps.kbLessonsDir, `${slug}.md`)
        : null;
    if (!path) {
      setProposalStatus(poolDir, p.id, "failed", { result: "无法确定 lesson 落点：提案没带目标路径，调用方也没给知识库目录" });
      return { ok: false, action: "failed", detail: "无法确定 lesson 落点（缺项目根目录信息）", files: [] };
    }
    const dir = dirname(path);
    if (existsSync(path)) {
      setProposalStatus(poolDir, p.id, "failed", { result: `同名 lesson 已存在，未覆盖：${path}` });
      return { ok: false, action: "skipped", detail: `同名 lesson 已存在，为避免覆盖人写内容而跳过：${path}`, files: [] };
    }
    try {
      mkdirSync(dir, { recursive: true });
      // 裸正文（未设置记忆模型时“正文=原文”）必须套上 lesson 骨架再落盘。
      // 真机事故（2026-09-21）：promote 一直直接写 p.body，于是没有 frontmatter、没有分节，
      // 16 篇 lesson 里有 9 篇是“记忆原文裸文件”——既过不了质量闸门，后续 agent 也读不出结构。
      const tagPool = entries.flatMap((e) => e.tags ?? []);
      const text = looksLikeLessonDoc(p.body)
        ? p.body.trimEnd() + "\n"
        : wrapRawLesson({ title: p.title, body: p.body, tags: tagPool, id: p.id });
      writeFileSync(path, text, "utf8");
    } catch (e) {
      setProposalStatus(poolDir, p.id, "failed", { result: `写入失败：${(e as Error).message}` });
      return { ok: false, action: "failed", detail: `写入失败：${(e as Error).message}`, files: [] };
    }
    // 条目标记为已晋升，指向这个文件（相对项目根更可读，这里直接给路径）
    const touched = markPromoted(poolDir, entries, path, log);
    if (deps.index) {
      for (const e of entries) {
        try {
          await deps.index.upsert([{ ...e, status: "promoted", promotedTo: path }]);
        } catch (err) {
          log(`[memory] 索引更新失败（不影响文件）：${(err as Error).message}`);
        }
      }
    }
    setProposalStatus(poolDir, p.id, "applied", { result: `已写入 ${path}` });
    log(`[memory] 提案 ${p.id} 已落地：${path}`);
    return { ok: true, action: "applied", detail: `已写入 ${path}（未 commit，请 git diff 审）`, files: [path, ...touched] };
  }

  // ---- 出口④ 归档：移到归档目录（归档≠删除）+ 索引移除 ----
  if (p.kind === "archive") {
    const archDir = deps.archiveDir ?? (deps.archiveDirFor ?? (() => join(poolDir, "archived")))(poolDir);
    const files: string[] = [];
    const failed: string[] = [];
    for (const e of entries) {
      if (!e.path || !existsSync(e.path)) {
        failed.push(`${e.id}（文件不存在）`);
        continue;
      }
      const dest = join(archDir, `${e.id}.md`);
      try {
        mkdirSync(archDir, { recursive: true });
        if (!existsSync(dest)) moveFileSafe(e.path, dest);
        else rmSync(e.path, { force: true }); // 归档里已有同名：不要留着重复文件
        files.push(dest);
      } catch (err) {
        failed.push(`${e.id}（${(err as Error).message}）`);
      }
    }
    if (deps.index && files.length) {
      try {
        await deps.index.remove(entries.filter((e) => files.some((f) => f.includes(e.id))).map((e) => e.id));
      } catch (err) {
        log(`[memory] 索引移除失败（下次 rebuild 会纠正）：${(err as Error).message}`);
      }
    }
    if (failed.length && !files.length) {
      setProposalStatus(poolDir, p.id, "failed", { result: `归档失败：${failed.join("；")}` });
      return { ok: false, action: "failed", detail: `归档失败：${failed.join("；")}`, files };
    }
    setProposalStatus(poolDir, p.id, "applied", {
      result: `已归档 ${files.length} 条${failed.length ? `，失败 ${failed.length} 条` : ""}`,
    });
    return {
      ok: true,
      action: "applied",
      detail: `已归档 ${files.length} 条到 ${archDir}${failed.length ? `（${failed.length} 条失败）` : ""}`,
      files,
    };
  }

  setProposalStatus(poolDir, p.id, "failed", { result: `未知提案类型：${p.kind}` });
  return { ok: false, action: "failed", detail: `未知提案类型：${p.kind}`, files: [] };
}

/**
 * 正文看起来已经是 lesson 文档了吗？
 * 判据与 dream 的 looksLikeBody（promote-kb）一致：有 frontmatter 的 `lesson:`，或 ≥2 个 `##`。
 */
export function looksLikeLessonDoc(body: string): boolean {
  const b = body || "";
  return RE_FM_LESSON.test(b) || (b.match(/^##\s+/gm) ?? []).length >= 2;
}

/**
 * 把"记忆原文"包成合格 lesson 骨架（保留原文，人再整理）。
 *
 * 为什么不做语义填充分配（把原文塞进 Fix/Guard 之类）：那是**猜测**，会把
 * "一条限制说明"写成"修复步骤"。宁可诚实分节留空 + 原文单独一节标明"待整理"。
 */
export function wrapRawLesson(opts: { title: string; body: string; tags?: string[]; id?: string }): string {
  const tags = [...new Set((opts.tags ?? []).filter(Boolean))];
  return [
    "---",
    `lesson: ${lessonSlug(opts.title, opts.id ?? "00000000").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`,
    "module: unknown",
    `tags: [${tags.join(", ")}]`,
    "source: zhiya",
    "guard-strength: directive",
    "applies-when: []",
    "---",
    "",
    `# ${opts.title}`,
    "",
    "> ⚠️ 本节骨架由知芽自动生成：正文取自**记忆原文**（未设置记忆模型，未生成 lesson 正文）。",
    "> `module` / `tags` / 各节内容需要人工整理；下面「原文」一节保留原始记录。",
    "",
    "## Symptom",
    "",
    "<!-- TODO：什么现象下会踩到？ -->",
    "",
    "## Root Cause",
    "",
    "<!-- TODO：为什么？ -->",
    "",
    "## Fix",
    "",
    "<!-- TODO：正确做法 -->",
    "",
    "## Guard",
    "",
    "<!-- TODO：以后怎么避免 -->",
    "",
    "## Evidence",
    "",
    "<!-- TODO：日志/命令/文件 -->",
    "",
    "## 原文（待整理）",
    "",
    opts.body.trim(),
    "",
  ].join(SEP_NL);
}

/** 生成 lesson 文档的骨架（供 dream 的模型填充；也给人工兜底用）。 */
export function lessonTemplate(opts: { title: string; module?: string; tags?: string[]; body?: string }): string {
  const { title, module = "unknown", tags = [], body = "" } = opts;
  return [
    "---",
    `lesson: ${lessonSlug(title, "00000000").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`,
    `module: ${module}`,
    `tags: [${tags.join(", ")}]`,
    "source: zhiya",
    "guard-strength: directive",
    "applies-when: []",
    "---",
    "",
    `# ${title}`,
    "",
    body.trim() || ["## Symptom", "", "## Root Cause", "", "## Fix", "", "## Guard", "", "## Evidence", ""].join("\n"),
    "",
  ].join("\n");
}

/** 读取已有 lesson 的 frontmatter 键（判断重复用，避免同名/同 lesson 重复写入）。 */
export function lessonKey(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    return /^lesson:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}
