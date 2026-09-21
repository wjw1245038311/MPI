/**
 * 知芽 Zhiya — the agent's growing mind, stored as plain Markdown under
 * ~/.pi/agent/zhiya/ so both the MPI desktop and terminal pi can read it.
 *
 * Two kinds of content:
 *   always-on   persona.md (in full) · agreement.md (its 硬规则 section + a
 *               pointer telling the agent when to read the rest) ·
 *               workspace.md (layout + local quick reference)
 *   on-demand   .alexandria/knowledge/ (per-project, pointer only) and the
 *               mem0 inbox (unfiled notes, never injected)
 *
 * The copies here are machine-independent mirrors; the editable masters live
 * in the private AgentSetting repo and are pulled one-way (master → copy).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { getConfig, updateConfig } from "./config";
import { configuredKnowledgeDir } from "./knowledge-dir";
import { getAgentDir } from "./session-store";

export const PERSONA_FILE = "persona.md";
export const AGREEMENT_FILE = "agreement.md";
export const WORKSPACE_FILE = "workspace.md";

/** Runtime files managed by zhiya, in stable order. */
export const ZHIYA_FILES = [PERSONA_FILE, AGREEMENT_FILE, WORKSPACE_FILE] as const;
export type ZhiyaFileName = (typeof ZHIYA_FILES)[number];

/**
 * Where each runtime file's master sits, relative to the zhiya master root
 * (e.g. the Obsidian vault's Zhiya-assets/). The master is the single source
 * of truth (git-synced across devices); the copy under ~/.pi/agent/zhiya/
 * exists only so every client can read a machine-independent path.
 */
const MASTER_REL: Record<ZhiyaFileName, string> = {
  [PERSONA_FILE]: join("人物画像", "Persona.md"),
  [AGREEMENT_FILE]: join("协作约定", "Agreement.md"),
  [WORKSPACE_FILE]: join("工作空间", "WorkspaceLayout.md"),
};

/** Total injected budget (chars) — guards the Windows command-line length. */
export const ZHIYA_PROMPT_BUDGET = 4000;

/** Section of agreement.md whose body is injected into every session. */
export const HARD_RULES_HEADING = "## 硬规则（常驻注入）";

const PERSONA_TEMPLATE = `# 人物画像（Persona）

> 只写「关于我这个人」的稳定事实。规则/约定写 agreement.md，环境事实写 workspace.md。

## 个人定位
<!-- 你是谁、做什么工作、agent 应该把你当成什么角色 -->

## 喜好
<!-- 技术栈偏好、审美、工具口味 -->

## 习惯
<!-- 工作方式：作息、迭代节奏 -->

## 沟通风格
<!-- 你希望 agent 怎么说话：详略、语气、语言 -->

## 禁忌与边界
<!-- 不要做什么：危险操作、不碰的目录/服务 -->
`;

const AGREEMENT_TEMPLATE = `# 协作约定（Agreement）

> agent 的「家规」：怎么用工作空间、不能动什么。规则写这里，环境事实写 workspace.md。

## 硬规则（常驻注入）
<!-- 只放「违反就出事」的规则，保持 3-5 行；每条尽量写明无人值守（定时任务）下的降级语义 -->
<!-- 例：
- 破坏性操作前二次确认；无人值守时跳过并记入待办
- 提交后先说明变更、等确认再推送
- 注释、文档、commit message 使用中文
-->

## 环境
<!-- 例：唯一 shell = Git Bash，禁用 PowerShell/cmd；Python 包管理用 uv -->

## 工作区与路径
<!-- 例：文件生命周期 Work/（调试）→ Code/（永久）；临时文件一律落 tempfile/ -->

## 工作原则
<!-- 环境锚点 / 职责分离 / 执行逻辑 / 最小必要 / 安全底线 / 代码规范 / 状态一致 -->

## 跨设备协作（devmail）
<!-- 例：「发送邮件 …」/「接收邮件」触发词 → 经 devmail 收发设备间邮件 -->

## 协作偏好
<!-- 例：排障时先复述理解再动手；「继续任务」= 从上次中断点恢复 -->
`;

const WORKSPACE_TEMPLATE = `# 工作空间（Workspace）

> 房子与水电煤：房间（目录）在哪、干什么用；本机有哪些服务与工具可用。
> 详细调用方式另存（例：同目录 ServiceGuide.md），这里只放速查。

## 空间布局
<!-- 一行一间房：<目录> — 用途（注入时只用本节） -->

## 本机速查
<!-- 一行一条：<服务/工具> — 用途 — 地址或路径（注入时只用本节，保持 10-15 行内） -->
`;

const TEMPLATES: Record<ZhiyaFileName, string> = {
  [PERSONA_FILE]: PERSONA_TEMPLATE,
  [AGREEMENT_FILE]: AGREEMENT_TEMPLATE,
  [WORKSPACE_FILE]: WORKSPACE_TEMPLATE,
};

/** Zhiya root dir (local copies); created on demand. */
export function zhiyaDir(): string {
  const dir = join(getAgentDir(), "zhiya");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath(name: ZhiyaFileName): string {
  return join(zhiyaDir(), name);
}

/** Local (machine-independent) copy. */
export function readZhiyaFile(name: ZhiyaFileName): string {
  try {
    const p = filePath(name);
    if (existsSync(p)) return readFileSync(p, "utf8");
  } catch {
    /* unreadable → treat as empty */
  }
  return "";
}

/** Write the local copy only. Prefer saveZhiyaFile() for user edits. */
export function writeZhiyaFile(name: ZhiyaFileName, text: string): void {
  zhiyaDir();
  writeFileSync(filePath(name), text.replace(/\r\n/g, "\n"), "utf8");
}

// ---------------------------------------------------------------------------
// Master (AgentSetting) — git truth source
// ---------------------------------------------------------------------------

let masterDirCache: string | null | undefined;

/** Looks like a zhiya master root? (loose signature check)
 *  New master (Zhiya-assets/): 人物画像/ 协作约定/ 工作空间/ dirs.
 *  Legacy master (AgentSetting): persona/ devices/ dirs. */
function looksLikeZhiyaMaster(dir: string): boolean {
  return (
    existsSync(join(dir, "人物画像")) ||
    existsSync(join(dir, "工作空间")) ||
    existsSync(join(dir, "persona")) ||
    existsSync(join(dir, "devices"))
  );
}

/**
 * Probe for the master dir: walk up from the last thread cwd looking for the
 * Obsidian vault's Zhiya-assets (`<root>/Agent/WJW/40-Private/Zhiya-assets`,
 * preferred) and the legacy AgentSetting, then fall back to
 * `<home>/MyWorkspace/...`. The result is persisted to config so detection
 * happens at most once.
 */
function detectMasterDir(): string | null {
  const seeds: string[] = [];
  const last = getConfig().lastThreadCwd;
  if (last && isAbsolute(last)) {
    let dir: string = last;
    for (let i = 0; i < 8; i++) {
      seeds.push(join(dir, "Agent", "WJW", "40-Private", "Zhiya-assets"));
      seeds.push(join(dir, "Agent", "AgentSetting"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  seeds.push(join(homedir(), "MyWorkspace", "Agent", "WJW", "40-Private", "Zhiya-assets"));
  seeds.push(join(homedir(), "MyWorkspace", "Agent", "AgentSetting"));
  for (const cand of seeds) {
    if (existsSync(cand) && looksLikeZhiyaMaster(cand)) return cand;
  }
  return null;
}

/**
 * The AgentSetting root, or null when this machine has none configured (then
 * zhiya works on the local copies alone — never silently pretends to sync).
 */
export function zhiyaMasterDir(): string | null {
  if (masterDirCache !== undefined) return masterDirCache;
  const configured = (getConfig().zhiyaMasterDir || "").trim();
  if (configured && existsSync(configured)) {
    masterDirCache = configured;
    return masterDirCache;
  }
  const detected = detectMasterDir();
  masterDirCache = detected;
  if (detected && detected !== configured) {
    try {
      updateConfig({ zhiyaMasterDir: detected });
    } catch {
      /* config write must never break injection */
    }
  }
  return masterDirCache;
}

/** Re-run detection (Settings changed / new machine layout). */
export function resetZhiyaMasterCache(): void {
  masterDirCache = undefined;
}

/**
 * Set the master root explicitly (Settings UI). Empty string clears the
 * override so detection runs again. Only existing directories are accepted;
 * the signature check is deliberately not enforced here — when the path is
 * wrong the file reads below simply come up empty.
 */
export function setZhiyaMasterDir(dir: string): { ok: boolean; masterDir: string | null } {
  const p = (dir || "").trim();
  if (p) {
    try {
      if (!statSync(p).isDirectory()) return { ok: false, masterDir: zhiyaMasterDir() };
    } catch {
      return { ok: false, masterDir: zhiyaMasterDir() };
    }
  }
  try {
    updateConfig({ zhiyaMasterDir: p || undefined });
  } catch {
    /* config write must never break injection */
  }
  resetZhiyaMasterCache();
  return { ok: true, masterDir: zhiyaMasterDir() };
}

function masterPath(name: ZhiyaFileName): string | null {
  const root = zhiyaMasterDir();
  return root ? join(root, MASTER_REL[name]) : null;
}

/** Absolute path of the runtime copy (always present after ensureZhiyaFiles). */
export function zhiyaLocalPath(name: ZhiyaFileName): string {
  return filePath(name);
}

/**
 * Absolute path of the master, when there is one. This is the file to hand to
 * an external editor: edits belong in the git truth source, otherwise a later
 * master→copy sync would silently overwrite them.
 */
export function zhiyaMasterPath(name: ZhiyaFileName): string | null {
  const p = masterPath(name);
  return p && existsSync(p) ? p : null;
}

/** Write the master. Returns false when unavailable (no AgentSetting here). */
export function writeMasterFile(name: ZhiyaFileName, text: string): boolean {
  const p = masterPath(name);
  if (!p) return false;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text.replace(/\r\n/g, "\n"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Save a user edit: master first (the truth source), then mirror to the local
 * copy. Without a master dir the local copy is the only home for the text.
 */
export function saveZhiyaFile(name: ZhiyaFileName, text: string): { master: boolean } {
  const master = writeMasterFile(name, text);
  writeZhiyaFile(name, text);
  return { master };
}

/**
 * One-way sync master → local copy, per file, only when the master is newer
 * (or the copy is missing). Local edits made outside the app are therefore
 * never clobbered by a stale master. Cheap enough to call at spawn time.
 */
export function syncZhiyaFromMaster(): void {
  const root = zhiyaMasterDir();
  if (!root) return;
  for (const name of ZHIYA_FILES) {
    const src = join(root, MASTER_REL[name]);
    try {
      if (!existsSync(src)) continue;
      const dst = filePath(name);
      const srcM = statSync(src).mtimeMs;
      const dstM = existsSync(dst) ? statSync(dst).mtimeMs : -1;
      if (srcM > dstM + 500) {
        zhiyaDir();
        copyFileSync(src, dst);
      }
    } catch {
      /* a failed sync must not break injection */
    }
  }
}

// ---------------------------------------------------------------------------
// Setup & migration
// ---------------------------------------------------------------------------

/** Create template files if missing (idempotent) and pull the latest masters. */
export function ensureZhiyaFiles(): void {
  zhiyaDir();
  // 09-18 rename: assets.md → workspace.md (never destroy existing content).
  const legacy = join(zhiyaDir(), "assets.md");
  const next = filePath(WORKSPACE_FILE);
  if (existsSync(legacy) && !existsSync(next)) {
    try {
      copyFileSync(legacy, next);
    } catch {
      /* keep going — a template will be written below */
    }
  }
  for (const name of ZHIYA_FILES) {
    const p = filePath(name);
    if (!existsSync(p)) writeFileSync(p, TEMPLATES[name], "utf8");
  }
  syncZhiyaFromMaster();
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
  const existing = readZhiyaFile(PERSONA_FILE);
  const isTemplateOnly = existing.trim() === PERSONA_TEMPLATE.trim();
  const text = isTemplateOnly
    ? `# 人物画像（Persona）\n\n${old}\n`
    : existing.replace(/\s*$/, "") + `\n\n## 迁移自旧「用户画像」设置\n\n${old}\n`;
  saveZhiyaFile(PERSONA_FILE, text);
  // The Settings tab is gone; the config field is dead weight from now on.
  updateConfig({ userProfile: undefined });
  return "migrated";
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

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

/** Body of a section, up to the next heading of the same or higher level. */
function extractSection(text: string, heading: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const level = (heading.match(/^#+/) || [""])[0].length || 1;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading.trim()) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

/**
 * Always-injected pointer block: tells the agent that the full agreement and
 * the project knowledge base exist *and when to go read them*. "On demand"
 * only works if the pointer is never truncated, hence its position right after
 * the hard rules.
 */
function buildZhiyaPointers(): string {
  // 知识库位置随知芽设置变（默认才是每项目的 .alexandria/knowledge）。
  const kb = configuredKnowledgeDir();
  const kbWhere = kb ? `\`${kb}\`（知芽设置里配的目录）` : "本项目根目录的 `.alexandria/knowledge/`（存在时）";
  return [
    "## 知芽 · 指针（按需读取）",
    "- **协作约定全文** `~/.pi/agent/zhiya/agreement.md`：涉及 git 提交/推送、破坏性操作（删除/覆盖/重置）、跨设备收发邮件（devmail「发送邮件」/「接收邮件」）、新建文件或目录、进入陌生项目、无人值守任务（定时任务）之前，先读该文件确认规则。",
    `- **知识库** ${kbWhere}：回答架构、数据流、模块职责、历史决策类问题前，先用 alexandria 检索它缩小范围，再读关键源码确认；证据不足时明确说明并回退到源码。`,
  ].join("\n");
}

/**
 * Drop everything before the first `##` heading — i.e. the file's H1 title and
 * any commentary right under it (authoring notes). The injected block already
 * carries its own heading, and preamble text is guidance for the human editor,
 * not instructions for the model. Files that are plain text (no `##`) are kept
 * whole.
 */
export function stripPreamble(text: string): string {
  const norm = text.replace(/\r\n/g, "\n");
  const m = norm.match(/^##\s/m);
  return m && m.index !== undefined ? norm.slice(m.index) : norm;
}

/**
 * Pure composition of the injected block: no I/O, no config, no electron —
 * which is what makes the injection contract testable (scripts/test-zhiya.mjs).
 *
 * Order is deliberate. Over-budget content is truncated from the TAIL, so
 * whatever must never be lost sits at the front: 硬规则 → 指针 → 画像 → 工作空间。
 * The pointer block is unconditional — "read the agreement on demand" only
 * works while the pointer is still there.
 */
export function composeZhiyaPrompt(sources: {
  agreement?: string;
  persona?: string;
  workspace?: string;
}): string {
  const hardRules = stripForInjection(extractSection(sources.agreement || "", HARD_RULES_HEADING));
  const persona = stripForInjection(stripPreamble(sources.persona || ""));
  const workspace = stripForInjection(stripPreamble(sources.workspace || ""));

  const parts: string[] = [];
  if (hardRules) parts.push(`## 知芽 · 硬规则（必须遵守）\n${hardRules}`);
  parts.push(buildZhiyaPointers());
  if (persona) parts.push(`## 知芽 · 人物画像\n${persona}`);
  if (workspace) parts.push(`## 知芽 · 工作空间\n${workspace}`);

  let out = parts.join("\n\n");
  if (out.length > ZHIYA_PROMPT_BUDGET) {
    out =
      out.slice(0, ZHIYA_PROMPT_BUDGET - 60).trimEnd() +
      "\n…（已截断：内容过长，完整见 ~/.pi/agent/zhiya/）";
  }
  return out;
}

/**
 * The text injected into every session's system prompt. Reads the files at
 * call time (spawn time), so external edits (Obsidian/VSCode) are picked up by
 * the next warm-bridge refresh.
 */
export function buildZhiyaPrompt(): string | undefined {
  syncZhiyaFromMaster();
  return composeZhiyaPrompt({
    agreement: readZhiyaFile(AGREEMENT_FILE),
    persona: readZhiyaFile(PERSONA_FILE),
    workspace: readZhiyaFile(WORKSPACE_FILE),
  });
}
