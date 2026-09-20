/**
 * 记忆池 op 执行器（P3）—— 扩展提出请求，主进程在这里执行
 *
 * 覆盖：dream（跑一次分诊）/ approve（批准提案并落地）/ reject（拒绝）
 * 以及回执落盘 <池>/ops.jsonl（扩展与面板读它，解决"提交后无反馈"的缺口）。
 *
 * 纪律：dream 是**重活**（本地模型跑 1-2 分钟），绝不能阻塞摄入循环——
 * 调用方拿到的只是"已启动"，结果进 ops.jsonl。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runDream, type DreamReport } from "./memory-dream";
import { applyProposal, type ApplyDeps } from "./memory-promote";
import { markConsolidated } from "./zhiya/consolidation";
import { listProposals, readProposal, setProposalStatus } from "./zhiya/proposals";
import type { OpLogEntry } from "./memory-inbox";

export function opLogPath(poolDir: string): string {
  return join(poolDir, "ops.jsonl");
}

/** 追加一条回执（JSONL：只追加、不重写，天然并发安全）。 */
export function appendOpResult(poolDir: string, entry: OpLogEntry): void {
  try {
    const path = opLogPath(poolDir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* 回执写不进去不该影响主流程 */
  }
}

/** 读最近 n 条回执（最新的在前）。 */
export function recentOpResults(poolDir: string, n = 10): OpLogEntry[] {
  const path = opLogPath(poolDir);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    return lines
      .slice(-n)
      .map((l) => JSON.parse(l) as OpLogEntry)
      .reverse();
  } catch {
    return [];
  }
}

export interface OpRunnerDeps {
  poolDir: string;
  /** 提案落地所需的落点（索引、归档目录、项目知识库） */
  apply: Pick<ApplyDeps, "index" | "archiveDir" | "archiveDirFor" | "kbLessonsDir">;
  log?: (m: string) => void;
  /** 单飞守卫：同一时刻只跑一个 dream（启动期慢任务不该叠加） */
  isDreaming?: () => boolean;
  setDreaming?: (v: boolean) => void;
}

/** dream：返回"已启动"，真正跑完的结果进 ops.jsonl。 */
export async function startDream(
  deps: OpRunnerDeps,
  dryRun: boolean,
  llmClassify = false,
): Promise<{ detail: string; files?: string[] }> {
  if (deps.isDreaming?.()) return { detail: "已有一次分诊在进行中，稍后再试" };
  deps.setDreaming?.(true);
  const log = deps.log ?? (() => {});
  void (async () => {
    try {
      // 记忆模型由设置决定；这里动态引入解析层（它要读 electron 的配置），
      // 免得把 electron 依赖拖进单元测试。
      const { resolveMemoryModel } = await import("./memory-model-runtime");
      const mm = resolveMemoryModel();
      const report: DreamReport = await runDream({
        poolDir: deps.poolDir,
        dryRun,
        llmClassify,
        log,
        mode: mm.mode,
        modelDesc: mm.describe,
        llmUrl: mm.url || undefined,
        llmModel: mm.model || undefined,
        llmKey: mm.key,
      });
      const detail = report.ok
        ? `分诊完成：${report.entries} 条 → ${report.proposals.length} 份提案（${(report.ms / 1000).toFixed(1)}s）${dryRun ? "（预览，未落盘）" : ""}`
        : `分诊未产出：${report.errors.join("；") || "未知原因"}`;
      if (report.ok && !dryRun) markConsolidated(deps.poolDir, "manual");
      for (const e of report.errors) log(`[memory] dream: ${e}`);
      appendOpResult(deps.poolDir, {
        at: new Date().toISOString(),
        op: dryRun ? "dream(dry)" : "dream",
        id: null,
        ok: report.ok,
        detail: `${detail}｜提案 id：${report.proposals.map((p) => p.id.slice(-6)).join(" ") || "无"}`,
      });
      log(`[memory] ${detail}`);
    } catch (e) {
      appendOpResult(deps.poolDir, {
        at: new Date().toISOString(),
        op: dryRun ? "dream(dry)" : "dream",
        id: null,
        ok: false,
        detail: `分诊异常：${(e as Error).message}`,
      });
      log(`[memory] dream 异常：${(e as Error).message}`);
    } finally {
      deps.setDreaming?.(false);
    }
  })();
  return { detail: "已启动周期分诊（本地模型跑 1-2 分钟，结果见 /memory-status 的回执）" };
}

/** approve：批准 + 立即落地（kb 写 lesson / archive 归档 / inject·now 待人工合并）。 */
export async function approveProposal(deps: OpRunnerDeps, id: string): Promise<{ detail: string; files?: string[] }> {
  const p = readProposal(deps.poolDir, id);
  if (!p) throw new Error(`找不到提案：${id}`);
  if (p.status !== "pending" && p.status !== "failed") throw new Error(`提案状态是 ${p.status}，不能批准`);
  const approved = setProposalStatus(deps.poolDir, id, "approved");
  if (!approved) throw new Error(`状态流转被拒绝：${p.status} → approved`);
  const r = await applyProposal(approved, {
    poolDir: deps.poolDir,
    index: deps.apply.index as ApplyDeps["index"],
    archiveDir: deps.apply.archiveDir,
    archiveDirFor: deps.apply.archiveDirFor,
    kbLessonsDir: deps.apply.kbLessonsDir,
    log: deps.log,
  });
  appendOpResult(deps.poolDir, {
    at: new Date().toISOString(),
    op: "approve",
    id,
    ok: r.ok,
    detail: r.detail,
  });
  return { detail: r.detail, files: r.files };
}

/** reject：只改状态（拒绝也要留痕，避免"这条为什么没晋升"无从查起）。 */
export async function rejectProposal(deps: OpRunnerDeps, id: string): Promise<{ detail: string }> {
  const p = readProposal(deps.poolDir, id);
  if (!p) throw new Error(`找不到提案：${id}`);
  const done = setProposalStatus(deps.poolDir, id, "rejected");
  if (!done) throw new Error(`状态流转被拒绝：${p.status} → rejected`);
  const detail = `已拒绝提案 ${id.slice(-6)}（${p.title}）`;
  appendOpResult(deps.poolDir, { at: new Date().toISOString(), op: "reject", id, ok: true, detail });
  return { detail };
}

/** 待审批提案数（/memory-status 与面板用）。 */
export function pendingCount(poolDir: string): number {
  return listProposals(poolDir).proposals.filter((p) => p.status === "pending").length;
}
