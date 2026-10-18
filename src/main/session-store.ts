import { createReadStream, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, type Stats } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { earlierDisplayMessages } from "./context-estimate";
import { getConfig, getConfigDir } from "./config";
import { getTrashDir } from "./trash-store";

/**
 * Zero-dependency reader for pi's session store (~/.pi/agent/sessions).
 *
 * We intentionally do NOT import the pi SDK here: the desktop app should keep
 * working even if pi's internal modules shift, and reading JSONL directly keeps
 * the main process bundle tiny. The directory name is a lossy encoding of the
 * cwd, so we group projects by the real `cwd` found in each file's header.
 */

export interface ThreadSummary {
  /** Absolute path to the .jsonl file; also the stable thread id. */
  file: string;
  /** Session id from the header. */
  id: string;
  /** Display name from the last session_info entry, else first user prompt. */
  title: string;
  /** First user prompt text, truncated (used as the list subtitle). */
  preview: string;
  /** Last activity time (ms epoch). */
  updatedAt: number;
  /** Conversation turns: user prompts plus agent final replies. */
  messageCount: number;
  /** Whether the session is pinned in the MPI sidebar. */
  pinned?: boolean;
}

export interface ProjectSummary {
  /** Real working directory, as stored in session headers. */
  cwd: string;
  /** Folder name shown in the sidebar. */
  name: string;
  threads: ThreadSummary[];
  /** Whether the project is pinned in the MPI sidebar. */
  pinned?: boolean;
  /** Set only for projects opened during the current desktop session. */
  openedAt?: number;
}

export function getAgentDir(): string {
  return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** pi's built-in session location: <agentDir>/sessions. */
export function defaultSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

/** Where MPI reads session files: the user-configured custom dir (Settings →
 * Data Storage) when set, else pi's default <agentDir>/sessions. The spawned
 * pi processes follow along via the `sessionDir` key in settings.json that
 * data-migration keeps in sync. */
export function getSessionsDir(): string {
  const custom = (getConfig().sessionStorageDir || "").trim();
  return custom ? resolve(custom) : defaultSessionsDir();
}

/** Every .jsonl under the sessions root: loose files at the root (custom dirs
 * are flat — pi's sessionDir layout never nests per project) plus one level of
 * subdirectories (the default layout). Non-recursive beyond that. */
export function listAllSessionFiles(root: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl")) out.push(join(root, e.name));
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      for (const f of readdirSync(join(root, e.name))) {
        if (f.endsWith(".jsonl")) out.push(join(root, e.name, f));
      }
    } catch {
      continue;
    }
  }
  return out.sort();
}

/** Stream a file line-by-line using only `\n` as delimiter (JSONL-safe). */
/**
 * 逐行读一个 JSONL 文件。
 *
 * 2026-10-18 改成 node 的 readline：旧实现是自己维护 `buf += chunk` + `buf.indexOf` +
 * `buf.slice`，遇到**超长行**（工具输出/base64 图片、单行可达 MB）时退化成平方级复制，
 * 实测 205 个会话 / 350MB 全量解析要 **15.8s**（同样的数据用 readline 只要 1.4s）。
 * 这个函数是会话摘要/用量/历史/搜索的公共入口，这里的 10 倍差直接就是启动卡 15s 的根因之一。
 */
export function forEachLine(file: string, onLine: (line: string) => void): Promise<void> {
  return (async () => {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (line.length) onLine(line);
      }
    } finally {
      rl.close();
    }
  })();
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b && b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

interface ParsedSkillPrompt {
  name: string;
  userMessage?: string;
}

function parseSkillPrompt(text: string): ParsedSkillPrompt | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return { name: match[1], userMessage: match[2]?.trim() || undefined };
}

function displayUserPrompt(text: string): string {
  const skill = parseSkillPrompt(text);
  return skill ? skill.userMessage || `skill: ${skill.name}` : text;
}

function displayThreadTitle(sessionName: string, promptText: string): string {
  const name = sessionName.trim();
  const prompt = displayUserPrompt(promptText).trim();
  const placeholder = /^(?:new thread|new task|新线程|新建任务)$/i.test(name);
  return name && !placeholder && !/^<skill(?:\s|>)/i.test(name) ? name : prompt;
}

/** True when an assistant message is a final user-facing reply: it triggers no
 * further tool calls and is not a failed model call. Intermediate model calls
 * (which contain toolCall blocks) are excluded so the thread count reflects
 * user prompts plus agent final replies only. */
function isFinalAssistantReply(m: any): boolean {
  if (!m || m.role !== "assistant") return false;
  if (m.stopReason === "error") return false;
  return !(Array.isArray(m.content) && m.content.some((b: any) => b && b.type === "toolCall"));
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

// 摘要缓存（mtime+size 为键，与下方 usageCache 同模式）：全量扫描所有会话
// ~700ms/127 文件/170MB，而 refreshProjects 在每次新建会话连接落地时都会跑——
// 不缓存的话侧边栏每次「新建」都卡一下。首扫后只重读有变化的文件。
const summaryCache = new Map<string, { mtimeMs: number; size: number; result: { summary: ThreadSummary; cwd: string } | null }>();

async function readThreadSummary(file: string): Promise<{ summary: ThreadSummary; cwd: string } | null> {
  let st: Stats;
  try {
    st = statSync(file);
  } catch {
    return null; // 文件不存在/不可读（与旧行为一致）
  }
  const hit = summaryCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;

  let id = "";
  let cwd = "";
  let name = "";
  let preview = "";
  let messageCount = 0;
  let lastTs = 0;
  try {
    await forEachLine(file, (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (!e || typeof e !== "object") return;
      if (e.type === "session") {
        id = e.id || id;
        cwd = e.cwd || cwd;
        const t = Date.parse(e.timestamp || "");
        if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
        return;
      }
      if (e.type === "session_info" && typeof e.name === "string" && e.name.trim()) {
        name = e.name.trim();
      }
      if (e.type === "message") {
        const m = e.message;
        if (m && m.role === "user") {
          messageCount++;
          if (!preview) preview = truncate(displayUserPrompt(textOfContent(m.content)), 90);
        } else if (isFinalAssistantReply(m)) {
          messageCount++;
        }
      }
      if (e.timestamp) {
        const t = Date.parse(e.timestamp);
        if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
      }
    });
  } catch {
    return null;
  }
  let result: { summary: ThreadSummary; cwd: string } | null = null;
  if (cwd) {
    const updatedAt = Math.max(lastTs, st.mtimeMs);
    const title = displayThreadTitle(name, preview) || "New thread";
    result = { summary: { file, id, title, preview, updatedAt, messageCount }, cwd };
  }
  // 缓存结果（含损坏文件的 null，避免反复重读）；简单封顶。
  summaryCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result });
  summaryCacheMutated = true;
  if (summaryCache.size > 4096) summaryCache.clear();
  return result;
}

/** Full transcript + display metadata read straight from a session .jsonl,
 *  without booting a pi process. Lets the UI render a thread instantly on
 *  click; a live process is only needed later for interaction. The `messages`
 *  array holds the raw pi message objects (same shape as the `get_messages`
 *  RPC), so the renderer reuses one conversion path for disk and live data. */
export interface ThreadHistory {
  cwd: string | null;
  sessionName: string | null;
  /** Current model from the last model_change entry, if any. */
  model: { provider: string; id: string } | null;
  /** Current thinking level from the last thinking_level_change entry. */
  thinkingLevel: string | null;
  messages: any[];
  /** Stable ids for user/assistant messages used by message-level branching. */
  branchMessages: { entryId: string; role: "user" | "assistant"; text: string }[];
}

export async function readThreadHistory(file: string): Promise<ThreadHistory> {
  let cwd: string | null = null;
  let sessionName: string | null = null;
  let model: { provider: string; id: string } | null = null;
  let thinkingLevel: string | null = null;
  const messages: any[] = [];
  const branchMessages: { entryId: string; role: "user" | "assistant"; text: string }[] = [];
  await forEachLine(file, (line) => {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!e || typeof e !== "object") return;
    switch (e.type) {
      case "session":
        if (e.cwd) cwd = e.cwd;
        break;
      case "session_info":
        if (typeof e.name === "string" && e.name.trim()) sessionName = e.name.trim();
        break;
      case "message":
        if (e.message) {
          messages.push(e.message);
          if ((e.message.role === "user" || e.message.role === "assistant") && e.id) {
            const text = textOfContent(e.message.content);
            branchMessages.push({ entryId: e.id, role: e.message.role, text });
          }
        }
        break;
      case "model_change":
        if (e.provider && e.modelId) model = { provider: e.provider, id: e.modelId };
        break;
      case "thinking_level_change":
        if (typeof e.thinkingLevel === "string") thinkingLevel = e.thinkingLevel;
        break;
      default:
        break;
    }
  });
  return { cwd, sessionName, model, thinkingLevel, messages, branchMessages };
}

/**
 * 「更早的对话」：活跃上下文之外（压缩点之前）的全部消息。
 * .jsonl 全量保留，pi getMessages 只返回「摘要 + 保留区 + 压缩后」；这里直接读磁盘、
 * 按与 pi buildContextEntries 相同的语义切分（context-estimate.ts），供 UI 懒加载展示。
 */
export async function readEarlierMessages(file: string): Promise<{ messages: any[] }> {
  const entries: unknown[] = [];
  await forEachLine(file, (line) => {
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") entries.push(e);
    } catch { /* 跳过坏行 */ }
  });
  return { messages: earlierDisplayMessages(entries, null) };
}

export interface ThreadSearchHit {
  /** Absolute path to the .jsonl file; also the stable thread id. */
  file: string;
  /** Real working directory of the project. */
  cwd: string;
  /** Display name of the thread. */
  title: string;
  /** Folder name of the project. */
  projectName: string;
  /** Last activity time (ms epoch). */
  updatedAt: number;
  /** Conversation turns: user prompts plus agent final replies. */
  messageCount: number;
  /** A snippet of the first matched text, with surrounding context. */
  snippet: string;
  /** Total number of keyword matches in the thread (capped). */
  matchCount: number;
  /** Set only when searching with archived/trashed sessions included:
   * "project-archived" = whole project folder is archived,
   * "thread-archived" = single session archived, "trashed" = in the trash bin.
   * Absent for live sessions. */
  state?: "project-archived" | "thread-archived" | "trashed";
}

function makeSnippet(text: string, idx: number, qlen: number): string {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + qlen + 70);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}

export async function searchOneFile(file: string, q: string): Promise<ThreadSearchHit | null> {
  let cwd = "";
  let name = "";
  let preview = "";
  let messageCount = 0;
  let lastTs = 0;
  let matchCount = 0;
  let snippet = "";

  const checkText = (text: string) => {
    if (!text) return;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx === -1) return;
    while (idx !== -1 && matchCount < 999) {
      matchCount++;
      if (!snippet) snippet = makeSnippet(text, idx, q.length);
      idx = lower.indexOf(q, idx + q.length);
    }
  };

  try {
    await forEachLine(file, (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (!e || typeof e !== "object") return;
      if (e.type === "session") {
        cwd = e.cwd || cwd;
        const t = Date.parse(e.timestamp || "");
        if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
        return;
      }
      if (e.type === "session_info" && typeof e.name === "string" && e.name.trim()) {
        name = e.name.trim();
      }
      if (e.type === "message") {
        const m = e.message;
        if (m) {
          const text = textOfContent(m.content);
          if (m.role === "user") {
            messageCount++;
            if (!preview) preview = truncate(displayUserPrompt(text), 90);
          } else if (isFinalAssistantReply(m)) {
            messageCount++;
          }
          if (m.role === "user" || m.role === "assistant") checkText(text);
        }
      }
      if (e.timestamp) {
        const t = Date.parse(e.timestamp);
        if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
      }
    });
  } catch {
    return null;
  }

  if (!cwd) return null;
  const title = displayThreadTitle(name, preview) || "New thread";
  if (title.toLowerCase().includes(q)) {
    if (!snippet) snippet = title;
    if (!matchCount) matchCount = 1;
  }
  if (!matchCount) return null;

  let updatedAt = lastTs;
  try {
    updatedAt = Math.max(updatedAt, statSync(file).mtimeMs);
  } catch {
    /* ignore */
  }

  return {
    file,
    cwd,
    title,
    projectName: basename(cwd) || cwd,
    updatedAt,
    messageCount,
    snippet,
    matchCount,
  };
}

/** Full-text search across every session's user/assistant text. */
export async function searchThreads(query: string, limit = 50): Promise<ThreadSearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const root = getSessionsDir();
  if (!existsSync(root)) return [];

  const files = listAllSessionFiles(root);

  const hits: ThreadSearchHit[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const idx = cursor++;
      const hit = await searchOneFile(files[idx], q);
      if (hit) hits.push(hit);
    }
  }
  const concurrency = 8;
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, worker));

  hits.sort((a, b) => b.matchCount - a.matchCount || b.updatedAt - a.updatedAt);
  return hits.slice(0, limit);
}

/** Full-text search across trashed sessions (<userData>/trash/*.jsonl).
 * Every hit is tagged state="trashed"; cwd/title come from the JSONL itself,
 * which still carries the original project header. */
export async function searchTrashThreads(query: string, limit = 50): Promise<ThreadSearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const root = getTrashDir();
  if (!existsSync(root)) return [];

  let files: string[] = [];
  try {
    for (const f of readdirSync(root)) if (f.endsWith(".jsonl")) files.push(join(root, f));
  } catch {
    return [];
  }

  const hits: ThreadSearchHit[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const idx = cursor++;
      const hit = await searchOneFile(files[idx], q);
      if (hit) {
        hit.state = "trashed";
        hits.push(hit);
      }
    }
  }
  const concurrency = 8;
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, worker));

  hits.sort((a, b) => b.matchCount - a.matchCount || b.updatedAt - a.updatedAt);
  return hits.slice(0, limit);
}

export interface TotalUsage {
  /** Sum of usage.totalTokens across every message in every session. */
  tokens: number;
  /** Sum of usage.cost.total across every message in every session. */
  cost: number;
  /** Number of session files scanned. */
  sessions: number;
  /** Like `tokens`, but only messages whose entry timestamp is today (local). */
  todayTokens: number;
  /** Like `cost`, but only messages whose entry timestamp is today (local). */
  todayCost: number;
}

async function sumUsageInFile(
  file: string,
  dayStartMs: number,
): Promise<{ tokens: number; cost: number; todayTokens: number; todayCost: number }> {
  let tokens = 0;
  let cost = 0;
  let todayTokens = 0;
  let todayCost = 0;
  try {
    await forEachLine(file, (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      const u = e?.message?.usage;
      if (!u || typeof u !== "object") return;
      const t = typeof u.totalTokens === "number" ? u.totalTokens : 0;
      const c = typeof u.cost?.total === "number" ? u.cost.total : 0;
      tokens += t;
      cost += c;
      if (t || c) {
        // Entries without a parseable timestamp count toward the totals only.
        const ts = Date.parse(e.timestamp || "");
        if (!Number.isNaN(ts) && ts >= dayStartMs) {
          todayTokens += t;
          todayCost += c;
        }
      }
    });
  } catch {
    /* ignore unreadable file */
  }
  return { tokens, cost, todayTokens, todayCost };
}

// ---------------------------------------------------------------------------
// Usage aggregation cache (keyed by mtime + size)
// ---------------------------------------------------------------------------
// The sidebar polls getTotalUsage() every 60s. Re-parsing the whole session
// library on each poll is a full disk scan for users with many large sessions,
// so per-file totals are cached and only files whose mtime OR size changed get
// re-read (steady state: usually just the one actively written session). The
// "today" bucket is relative to local midnight, so when the day rolls over the
// whole cache is dropped and rebuilt once. Entries for deleted files are pruned
// on each call; switching the data-storage dir needs no special handling — new
// paths simply miss the cache and stale ones get pruned.

interface UsageFileCache {
  mtimeMs: number;
  size: number;
  tokens: number;
  cost: number;
  todayTokens: number;
  todayCost: number;
}

const usageCache = new Map<string, UsageFileCache>();
let usageCacheDay = ""; // local day (YYYY-MM-DD) the cached "today" values belong to

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 扫描耗时日志的注入点：session-store 不 import electron（测试要能用），
// 由主进程在启动时把 appendDiagLog 注进来。
// ---------------------------------------------------------------------------
let scanLogger: ((line: string) => void) | null = null;
/** 主进程启动时注入 `appendDiagLog`；测试里保持 null（不落日志）。 */
export function setScanLogger(fn: (line: string) => void): void {
  scanLogger = fn;
}

// ---------------------------------------------------------------------------
// 缓存落盘（2026-10-18）
//
// 实测：205 个会话 / 350MB 全量解析一次（摘要或用量各一遍）在冷启动时把主线程占满，
// 表现为 `ipc-slow app:getProjects 16s`、`app:getTotalUsage 16s`、窗口首屏 9.9s、
// 后续 `thread:open` 排队 3～12s。以前摘要/用量缓存只在内存里，每次重启都重算。
// 现在按「文件 mtime + size」持久化到 `<userData>/session-cache.json`：
//   · 重启后只需 stat 一轮（205 文件实测 38ms），冷启动不再卡壳；
//   · 「今天」的用量值带日期，跨天失效重算（与内存逻辑一致）；
//   · 写盘失败不影响主流程（缓存丢了只是下次慢一点）。
// ---------------------------------------------------------------------------
const SESSION_CACHE_SCHEMA = 1;
let sessionCacheLoaded = false;
let sessionCacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
/** 本次 scan 是否真的重读过文件（只重读才需要落盘）。 */
let summaryCacheMutated = false;

function sessionCachePath(): string | null {
  try {
    const dir = getConfigDir();
    return dir ? join(dir, "session-cache.json") : null;
  } catch {
    return null;
  }
}

function loadSessionCacheIfNeeded(): void {
  if (sessionCacheLoaded) return;
  sessionCacheLoaded = true;
  const file = sessionCachePath();
  if (!file || !existsSync(file)) return;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  if (!parsed || parsed.schema !== SESSION_CACHE_SCHEMA) return;
  const dk = localDayKey(new Date());
  usageCacheDay = dk;
  for (const entry of Array.isArray(parsed.summary) ? parsed.summary : []) {
    if (!Array.isArray(entry) || entry.length < 4) continue;
    const [path, mtimeMs, size, result] = entry;
    if (typeof path !== "string" || typeof mtimeMs !== "number" || typeof size !== "number") continue;
    summaryCache.set(path, { mtimeMs, size, result: result ?? null });
  }
  for (const entry of Array.isArray(parsed.usage) ? parsed.usage : []) {
    if (!Array.isArray(entry) || entry.length < 8) continue;
    const [path, mtimeMs, size, tokens, cost, todayTokens, todayCost, day] = entry;
    if (typeof path !== "string" || typeof mtimeMs !== "number" || typeof size !== "number") continue;
    // 「今天」只对写入当天有效：跨天就丢掉这条，让下次扫描重算
    if (day !== dk) continue;
    usageCache.set(path, {
      mtimeMs,
      size,
      tokens: tokens || 0,
      cost: cost || 0,
      todayTokens: todayTokens || 0,
      todayCost: todayCost || 0,
    });
  }
}

function saveSessionCacheNow(): void {
  if (sessionCacheSaveTimer) {
    clearTimeout(sessionCacheSaveTimer);
    sessionCacheSaveTimer = null;
  }
  const file = sessionCachePath();
  if (!file) return;
  const dk = usageCacheDay || localDayKey(new Date());
  const payload = {
    schema: SESSION_CACHE_SCHEMA,
    savedAt: Date.now(),
    summary: [...summaryCache].map(([path, e]) => [path, e.mtimeMs, e.size, e.result]),
    usage: [...usageCache].map(([path, e]) => [
      path,
      e.mtimeMs,
      e.size,
      e.tokens,
      e.cost,
      e.todayTokens,
      e.todayCost,
      dk,
    ]),
  };
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), "utf8");
    renameSync(tmp, file);
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

function scheduleSessionCacheSave(): void {
  if (sessionCacheSaveTimer) return;
  sessionCacheSaveTimer = setTimeout(() => {
    sessionCacheSaveTimer = null;
    saveSessionCacheNow();
  }, 1500);
}

/** 冷启动解析时每处理完一个文件让出一次事件循环，避免把 IPC 队列饿死。 */
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Aggregate token/cost usage across every session file (all-time plus local-today). */
export async function getTotalUsage(): Promise<TotalUsage> {
  const scanStartedAt = Date.now();
  const root = getSessionsDir();
  if (!existsSync(root)) return { tokens: 0, cost: 0, sessions: 0, todayTokens: 0, todayCost: 0 };
  loadSessionCacheIfNeeded();
  const files = listAllSessionFiles(root);
  const now = new Date();
  const dayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  // "today" values are only valid for the local day they were computed on.
  const dk = localDayKey(now);
  if (dk !== usageCacheDay) {
    usageCache.clear();
    usageCacheDay = dk;
  }

  let tokens = 0;
  let cost = 0;
  let todayTokens = 0;
  let todayCost = 0;
  const toParse: Array<{ file: string; mtimeMs: number; size: number }> = [];

  for (const file of files) {
    let st: Stats;
    try {
      st = statSync(file);
    } catch {
      continue; // vanished between listing and stat — skip it
    }
    const hit = usageCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      tokens += hit.tokens;
      cost += hit.cost;
      todayTokens += hit.todayTokens;
      todayCost += hit.todayCost;
    } else {
      toParse.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    }
  }

  let cursor = 0;
  async function worker() {
    while (cursor < toParse.length) {
      const idx = cursor++;
      const item = toParse[idx];
      const r = await sumUsageInFile(item.file, dayStartMs);
      usageCache.set(item.file, { mtimeMs: item.mtimeMs, size: item.size, ...r });
      tokens += r.tokens;
      cost += r.cost;
      todayTokens += r.todayTokens;
      todayCost += r.todayCost;
      // 冷启动时（重启后首次）这里会连续解析几百 MB；让出一拍，IPC 不至于全排队。
      await yieldToLoop();
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, Math.max(1, toParse.length)) }, worker));
  if (toParse.length) scheduleSessionCacheSave();
  // 只有「真的重解析了一批」才记日志：平时轮询全命中缓存，不要刷屏。
  if (toParse.length > 20) {
    scanLogger?.(`perf scan-usage files=${files.length} parsed=${toParse.length} ${Date.now() - scanStartedAt}ms`);
  }

  // Prune entries for files that no longer exist (deleted/trashed sessions).
  const alive = new Set(files);
  for (const key of usageCache.keys()) if (!alive.has(key)) usageCache.delete(key);

  return { tokens, cost, sessions: files.length, todayTokens, todayCost };
}

/** Read every session file under the sessions dir, grouped by real cwd. */
export async function scanProjects(): Promise<ProjectSummary[]> {
  const scanStartedAt = Date.now();
  const root = getSessionsDir();
  if (!existsSync(root)) return [];
  loadSessionCacheIfNeeded();

  const groups = new Map<string, ProjectSummary>();
  // light concurrency limit
  const queue: string[] = listAllSessionFiles(root);
  // Prune cache entries for files that no longer exist (deleted/trashed sessions).
  if (summaryCache.size > queue.length) {
    const alive = new Set(queue);
    for (const key of summaryCache.keys()) if (!alive.has(key)) summaryCache.delete(key);
  }

  const concurrency = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const idx = cursor++;
      const file = queue[idx];
      const read = await readThreadSummary(file);
      if (read) {
        const { summary, cwd } = read;
        let group = groups.get(cwd);
        if (!group) {
          group = { cwd, name: basename(cwd) || cwd, threads: [] };
          groups.set(cwd, group);
        }
        group.threads.push(summary);
      }
      // 冷启动时要全量解析所有会话（这里是首屏最大的阻塞源）；让出一拍避免 IPC 饿死。
      await yieldToLoop();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));
  if (summaryCacheMutated) {
    summaryCacheMutated = false;
    scheduleSessionCacheSave();
  }
  // 冷扫描（重启后首次）才记数：命中缓存时这里只有 stat 成本。
  const scanMs = Date.now() - scanStartedAt;
  if (scanMs > 400) scanLogger?.(`perf scan-summary files=${queue.length} ${scanMs}ms`);

  const projects = [...groups.values()];
  for (const p of projects) p.threads.sort((a, b) => b.updatedAt - a.updatedAt);
  projects.sort((a, b) => {
    const la = a.threads[0]?.updatedAt ?? 0;
    const lb = b.threads[0]?.updatedAt ?? 0;
    return lb - la;
  });
  return projects;
}

export interface CompactionStats {
  /** Number of compaction entries recorded in this session file. */
  count: number;
  /** ISO timestamp of the most recent compaction entry, or null when none. */
  lastAt: string | null;
}

/**
 * Counts the `compaction` entries a session JSONL has accumulated (every
 * successful auto- or manual compaction appends one). Streams line-by-line and
 * only parses lines that look like compactions, so large sessions stay fast.
 * Returns null when the path is outside pi's sessions dir or unreadable.
 */
export async function readSessionCompactions(filePath: string): Promise<CompactionStats | null> {
  const root = getSessionsDir();
  let resolved: string;
  try {
    resolved = resolve(filePath);
  } catch {
    return null;
  }
  if (!resolved.startsWith(root + sep)) return null;

  let count = 0;
  let lastAt: string | null = null;
  try {
    await forEachLine(resolved, (line) => {
      // Fast pre-filter before JSON.parse — compaction lines are rare.
      if (!line.includes('"type":"compaction"')) return;
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "compaction") return;
        count += 1;
        // Entries append chronologically; the last one wins.
        if (typeof entry.timestamp === "string" && entry.timestamp) lastAt = entry.timestamp;
      } catch {
        // Ignore malformed lines.
      }
    });
  } catch {
    return null; // Missing or unreadable file (e.g. session not created yet).
  }
  return { count, lastAt };
}
