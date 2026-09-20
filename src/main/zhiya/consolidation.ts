/**
 * 巩固累加器（P3）—— "什么时候该跑一次 dream"
 *
 * 机制（MEMORY-MODEL.md §5）：每写入一条记忆，从 150 分里**减去该条的重要性**；
 * 减到 0 就触发一次巩固。用减法而不是数条数，是因为"重要的记忆更快把阈值推满"。
 *
 * 状态落盘在 <池>/.consolidation.json（点号开头 → 不会被 inbox 摄入逻辑当候选）。
 * 注意：**触发不等于自动执行**。触发只记状态并喊一声；真跑不跑看配置与用户。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONSOLIDATION_THRESHOLD,
  debit,
  dueForConsolidation,
  newConsolidation,
  settle,
  type ConsolidationState,
} from "./triage";

export function consolidationPath(poolDir: string): string {
  return join(poolDir, ".consolidation.json");
}

/** 读状态；文件缺失/损坏一律当"满额"（宁可多跑一次，不可丢分）。 */
export function loadConsolidation(poolDir: string): ConsolidationState {
  const path = consolidationPath(poolDir);
  if (!existsSync(path)) return newConsolidation();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ConsolidationState>;
    if (typeof raw.remaining !== "number" || !Number.isFinite(raw.remaining)) return newConsolidation();
    return {
      remaining: raw.remaining,
      writes: Number(raw.writes) || 0,
      consumed: Number(raw.consumed) || 0,
      lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
      lastRunBy: raw.lastRunBy === "auto" || raw.lastRunBy === "manual" ? raw.lastRunBy : null,
    };
  } catch {
    return newConsolidation();
  }
}

/**
 * 写状态。
 * 这里**刻意不做 rename 原子替换**：Windows 上高频写这种小文件时，
 * 临时文件刚写完就被杀软/索引器拉住，rename 会随机报 EPERM（实测跑 25 次必现）。
 * 代价可接受：这个文件只是累加器，写坏了大不了退回"满额"（= 早一点跑一次巩固），
 * 而 loadConsolidation 已经对坏 JSON 做了兼容。
 */
export function saveConsolidation(poolDir: string, state: ConsolidationState): void {
  const path = consolidationPath(poolDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 1), "utf8");
}

/** 记一笔写入（返回是否到点）。 */
export function noteIngest(poolDir: string, importance: number): { state: ConsolidationState; triggered: boolean } {
  const r = debit(loadConsolidation(poolDir), importance);
  saveConsolidation(poolDir, r.state);
  return r;
}

/** 巩固跑完（自动/手动）后重置满额。 */
export function markConsolidated(poolDir: string, by: "auto" | "manual", now = new Date().toISOString()): ConsolidationState {
  const next = settle(loadConsolidation(poolDir), by, now);
  saveConsolidation(poolDir, next);
  return next;
}

export function consolidationDue(poolDir: string): boolean {
  return dueForConsolidation(loadConsolidation(poolDir));
}

export { CONSOLIDATION_THRESHOLD };
