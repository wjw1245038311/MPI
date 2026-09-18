/**
 * 知芽 Zhiya — the agent's growing mind, stored as plain Markdown under
 * ~/.pi/agent/zhiya/ so both the MPI desktop and terminal pi can read it.
 *
 *   persona.md  人物画像 (top layer) — who the user is: positioning,
 *               preferences, habits, communication style, boundaries.
 *   assets.md   资产 — local services/tools on this machine.
 *
 * Both files are injected into every session's system prompt via pi's
 * --append-system-prompt (see buildZhiyaPrompt). The long-term knowledge base
 * lives per-project in .alexandria/knowledge/ and is queried on demand, not
 * injected; mem0 stays the short-term memory layer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig, updateConfig } from "./config";
import { getAgentDir } from "./session-store";

export const PERSONA_FILE = "persona.md";
export const ASSETS_FILE = "assets.md";

/** Total injected budget (chars). Windows command-line length guard. */
export const ZHIYA_PROMPT_BUDGET = 4000;

const PERSONA_TEMPLATE = `# 人物画像（Persona）

## 个人定位
<!-- 你是谁、做什么工作、agent 应该把你当成什么角色 -->

## 喜好
<!-- 技术栈偏好、审美、工具口味 -->

## 习惯
<!-- 工作方式：作息、迭代节奏、沟通偏好 -->

## 沟通风格
<!-- 你希望 agent 怎么说话：详略、语气、语言 -->

## 禁忌与边界
<!-- 不要做什么：危险操作、不碰的目录/服务 -->
`;

const ASSETS_TEMPLATE = `# 资产（Assets）

## 服务
<!-- 一行一条，例：- mem0 语义记忆 — http://127.0.0.1:8000 -->

## 工具
<!-- 一行一条，例：- alexandria v0.1.3 — E:\\MyWorkspace\\Software\\alexandria\\alexandria.exe -->
`;

/** Zhiya root dir; created on demand. */
export function zhiyaDir(): string {
  const dir = join(getAgentDir(), "zhiya");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath(name: string): string {
  return join(zhiyaDir(), name);
}

export function readZhiyaFile(name: string): string {
  try {
    const p = filePath(name);
    if (existsSync(p)) return readFileSync(p, "utf8");
  } catch {
    /* unreadable → treat as empty */
  }
  return "";
}

export function writeZhiyaFile(name: string, text: string): void {
  zhiyaDir();
  writeFileSync(filePath(name), text.replace(/\r\n/g, "\n"), "utf8");
}

/** Create template files if missing (idempotent). */
export function ensureZhiyaFiles(): void {
  const persona = filePath(PERSONA_FILE);
  if (!existsSync(persona)) writeFileSync(persona, PERSONA_TEMPLATE, "utf8");
  const assets = filePath(ASSETS_FILE);
  if (!existsSync(assets)) writeFileSync(assets, ASSETS_TEMPLATE, "utf8");
}

/**
 * One-time migration: the old Settings → 用户画像 free text (config.userProfile)
 * becomes part of persona.md. Idempotent — after it runs, userProfile is
 * cleared so the condition can never fire again. Never destroys an existing
 * non-template persona.md; in that case the legacy text is appended instead.
 */
export function migrateUserProfileToZhiya(): "migrated" | "skipped" {
  const old = (getConfig().userProfile || "").trim();
  if (!old) return "skipped";
  ensureZhiyaFiles();
  const p = filePath(PERSONA_FILE);
  const existing = readFileSync(p, "utf8");
  const isTemplateOnly = existing.trim() === PERSONA_TEMPLATE.trim();
  if (isTemplateOnly) {
    writeZhiyaFile(PERSONA_FILE, `# 人物画像（Persona）\n\n${old}\n`);
  } else {
    writeZhiyaFile(
      PERSONA_FILE,
      existing.replace(/\s*$/, "") + `\n\n## 迁移自旧「用户画像」设置\n\n${old}\n`,
    );
  }
  // The Settings tab is gone; the config field is dead weight from now on.
  updateConfig({ userProfile: undefined });
  return "migrated";
}

/**
 * Strip authoring guidance (HTML comments) and empty sections so only what the
 * user actually wrote reaches the system prompt.
 */
export function stripForInjection(text: string): string {
  const noComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const out: string[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (heading === null) {
      out.push(...body);
    } else if (body.some((l) => l.trim())) {
      out.push(heading, ...body);
    }
    body = [];
  };
  for (const line of noComments.split("\n")) {
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      heading = line;
    } else {
      body.push(line);
    }
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The text injected into every session's system prompt. Reads the files at
 * call time (spawn time), so external edits (Obsidian/VSCode) are picked up by
 * the next warm-bridge refresh. undefined = nothing to inject.
 */
export function buildZhiyaPrompt(): string | undefined {
  const persona = stripForInjection(readZhiyaFile(PERSONA_FILE));
  const assets = stripForInjection(readZhiyaFile(ASSETS_FILE));
  if (!persona && !assets) return undefined;
  const parts: string[] = [];
  if (persona) parts.push(`## Soul · Persona\n${persona}`);
  if (assets) parts.push(`## Soul · Assets\n${assets}`);
  let out = parts.join("\n\n");
  if (out.length > ZHIYA_PROMPT_BUDGET) {
    out =
      out.slice(0, ZHIYA_PROMPT_BUDGET - 60).trimEnd() +
      "\n…（已截断：内容过长，完整见 ~/.pi/agent/zhiya/）";
  }
  return out;
}

