import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { getConfig, updateConfig } from "./config";

/** 显式配置的知识库目录（空 = 未配置，回退到每项目）。
 *  config 未加载时（测试 / 启动早期）按未配置处理，不抛。 */
export function configuredKnowledgeDir(): string | null {
  try {
    const cfg = (getConfig().knowledgeDir || "").trim();
    return cfg || null;
  } catch {
    return null;
  }
}

/**
 * 知识库根目录：优先显式配置（设一次即可跨项目共享，目录里放 md 文件），
 * 否则回退到 `<项目根>/.alexandria/knowledge`（跟项目仓库走）。都没有时为 null。
 */
export function knowledgeRoot(projectCwd?: string | null): string | null {
  const configured = configuredKnowledgeDir();
  if (configured) return configured;
  return projectCwd ? join(projectCwd, ".alexandria", "knowledge") : null;
}

/** lessons 子目录（记忆晋升 / 巩固的落盘目标）。 */
export function knowledgeLessonsDir(projectCwd?: string | null): string | null {
  const root = knowledgeRoot(projectCwd);
  return root ? join(root, "lessons") : null;
}

/**
 * 知识库目录的**默认值**（新电脑首次启动时写回 config，避免落空）。
 *
 * 为什么需要：仓库内 `<项目根>/.alexandria/knowledge` 这条回退在 2026-09-21 的清理里
 * 被删除（知识库迁到工作空间外的 vault 目录），于是"没配 knowledgeDir"的实例
 * （新装机 / 发行版实例 / 其它设备）知识库会直接落空。这里按与母版目录同一套策略
 * ——**探测一次并写回 config**——给一个可用默认值。
 *
 * 约定与记忆池一致（`defaultPoolDir()`）：环境变量覆盖 → `PI_AGENT_DIR` → `~/.pi/agent`。
 */
export function defaultKnowledgeDir(): string {
  if (process.env.MPI_ZHIYA_KNOWLEDGE_DIR) return process.env.MPI_ZHIYA_KNOWLEDGE_DIR;
  const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "zhiya", "knowledge");
}

/**
 * 探测知识库目录：从 lastThreadCwd 向上找本机工作空间布局里的
 * `<root>/Agent/WJW/30-Resources`（母版 AgentSetting 的同级 vault 目录），
 * 再退回 home 下的同名位置。找不到返回 null（调用方用 defaultKnowledgeDir 兜底）。
 */
export function detectKnowledgeDir(): string | null {
  const seeds: string[] = [];
  let last: string | undefined;
  try {
    last = getConfig().lastThreadCwd;
  } catch {
    last = undefined;
  }
  if (last && isAbsolute(last)) {
    let dir: string = last;
    for (let i = 0; i < 8; i++) {
      seeds.push(join(dir, "Agent", "WJW", "30-Resources"));
      seeds.push(join(dir, "WJW", "30-Resources"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  seeds.push(join(homedir(), "MyWorkspace", "Agent", "WJW", "30-Resources"));
  for (const cand of seeds) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * 首次启动把"知识库目录"落成默认值（探测到的 vault 目录，否则本机 zhiya/knowledge）。
 * 已配置则原样返回；写回失败不阻塞使用。
 */
export function ensureKnowledgeDirConfigured(): string {
  const configured = configuredKnowledgeDir();
  if (configured) return configured;
  const detected = detectKnowledgeDir() || defaultKnowledgeDir();
  try {
    updateConfig({ knowledgeDir: detected });
    if (!existsSync(detected)) mkdirSync(detected, { recursive: true });
  } catch {
    /* 写配置 / 建目录失败都不能影响主流程 */
  }
  return detected;
}
