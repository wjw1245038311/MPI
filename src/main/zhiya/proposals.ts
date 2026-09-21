/**
 * 提案存储（P3）—— dream 的产出落地为文件，审批改状态
 *
 * 为什么提案也是文件：它要进 git、要被人工 diff 审、要能跨设备看。
 * 池子是临时记忆，提案是"准备变成长期内容"的阶段，天然属于文件世界。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProposal, serializeProposal, type Proposal, type ProposalStatus } from "./triage";

/** 提案目录：<池>/proposals/（平铺，不按月分——提案生命周期短）。 */
export function proposalDir(poolDir: string): string {
  return join(poolDir, "proposals");
}

export function proposalPath(poolDir: string, id: string): string {
  return join(proposalDir(poolDir), `${id}.md`);
}

export function writeProposal(poolDir: string, p: Proposal): string {
  const dir = proposalDir(poolDir);
  mkdirSync(dir, { recursive: true });
  const path = proposalPath(poolDir, p.id);
  writeFileSync(path, serializeProposal(p), "utf8");
  return path;
}

/** 读单条；文件不存在或损坏返回 null（调用方自己决定怎么办）。 */
export function readProposal(poolDir: string, id: string): Proposal | null {
  const path = proposalPath(poolDir, id);
  if (!existsSync(path)) return null;
  try {
    const r = parseProposal(readFileSync(path, "utf8"));
    return r.ok ? r.proposal : null;
  } catch {
    return null;
  }
}

export interface ProposalList {
  proposals: Proposal[];
  /** 坏文件（解析失败）——不静默吞掉，面板/CLI 要能看见 */
  broken: { path: string; reason: string }[];
}

/** 列出全部提案，最近创建的在前。 */
export function listProposals(poolDir: string): ProposalList {
  const dir = proposalDir(poolDir);
  const out: Proposal[] = [];
  const broken: { path: string; reason: string }[] = [];
  if (!existsSync(dir)) return { proposals: out, broken };
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      const r = parseProposal(readFileSync(path, "utf8"));
      if (r.ok) out.push(r.proposal);
      else broken.push({ path, reason: r.reason });
    } catch (e) {
      broken.push({ path, reason: (e as Error).message });
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { proposals: out, broken };
}

export function pendingProposals(poolDir: string): Proposal[] {
  return listProposals(poolDir).proposals.filter((p) => p.status === "pending");
}

/** 状态流转：只允许 pending → approved/rejected，approved → applied/failed。 */
const ALLOWED: Record<ProposalStatus, ProposalStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["applied", "failed"],
  rejected: [],
  applied: [],
  failed: ["approved"], // 失败可以重试
};

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** 更新状态（可选带执行结果）。返回更新后的提案；不允许的流转返回 null。 */
export function setProposalStatus(
  poolDir: string,
  id: string,
  to: ProposalStatus,
  extra: { result?: string; decidedAt?: string } = {},
): Proposal | null {
  const p = readProposal(poolDir, id);
  if (!p) return null;
  if (!canTransition(p.status, to)) return null;
  const next: Proposal = {
    ...p,
    status: to,
    decidedAt: to === "approved" || to === "rejected" ? (extra.decidedAt ?? new Date().toISOString()) : p.decidedAt,
    result: extra.result ?? p.result,
  };
  writeProposal(poolDir, next);
  return next;
}

/**
 * 只更新结果说明，不动状态。
 * 用于「状态本来就不变、只是补一句结果」的场景（例：approved 的注入类提案
 * 追加「待人工合并」说明——若走 setProposalStatus(approved→approved) 会被判非法流转而丢失）。
 */
export function setProposalResult(poolDir: string, id: string, result: string): Proposal | null {
  const p = readProposal(poolDir, id);
  if (!p) return null;
  const next: Proposal = { ...p, result };
  writeProposal(poolDir, next);
  return next;
}

