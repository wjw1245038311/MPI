/**
 * MPI 记忆池捕获 bridge for pi（loaded via --extension, see memory-extension.ts）。
 *
 * 职责（只做"捕获 + 打分"，**不写池子**）：
 *   会话收尾 / 压缩前 / 关闭时，读本会话新增的对话 → 本机模型抽取候选 → 打分 → 每条一个 JSON
 *   丢进 <userData>/zhiya-memory-inbox/，由主进程统一落池（主进程是唯一写者）。
 *
 * ⚠️ 本文件是以 `?raw` 源码写进 userData 后被 pi 加载的，**必须自包含**：
 *    不能 import 本仓模块（import 得到的路径在 userData 下不存在）。
 *    跨进程契约只有一处：inbox 里的候选 JSON 形状，需与 src/main/memory-inbox.ts 保持一致。
 *
 * Env（pi-bridge 在 spawn 时注入）：
 *   MPI_MEMORY_INBOX_DIR   绝对路径 <userData>/zhiya-memory-inbox/
 *   MPI_MEMORY_SESSION_FILE 本会话 JSONL 绝对路径（可选，拿不到时用 ctx.sessionManager）
 *   MPI_MEMORY_LLM_URL     抽取模型端点（默认 LM Studio :1234）
 *   MPI_MEMORY_LLM_MODEL   模型 id
 *   MPI_MEMORY_EMBED_URL   embedding 端点（默认 llama-server :1235）
 *   MPI_MEMORY_PROJECT     当前项目名（默认取 cwd 末段）
 *
 * 失败策略：全程 fail-open——抽不出来、模型不在、写文件失败，都只写 stderr 一行，绝不影响对话。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const INBOX = process.env.MPI_MEMORY_INBOX_DIR || "";
const LLM_URL = process.env.MPI_MEMORY_LLM_URL || "http://127.0.0.1:1234/v1/chat/completions";
const LLM_MODEL = process.env.MPI_MEMORY_LLM_MODEL || "qwen3.8-27b@q5_k_m";
const EMBED_URL = process.env.MPI_MEMORY_EMBED_URL || "http://127.0.0.1:1235/v1/embeddings";
const SESSION_FILE = process.env.MPI_MEMORY_SESSION_FILE || "";

/** 抽取窗口大小（条）与单条截断（字符）——控制 token 与噪声。 */
const WINDOW_MAX = 30;
const MSG_MAX_CHARS = 1200;
const CONTEXT_MAX_CHARS = 2000;
/** 单次抽取的窗口上限。超了要分段：本机是推理模型，长窗口会把 token 烧在思考上，
 *  实测 4753 字符的窗口会返回空（content 与 reasoning 都空）→ 抽取静默失败。 */
const EXTRACT_CHUNK_CHARS = Number(process.env.MPI_MEMORY_CHUNK_CHARS || 3000);
const EXTRACT_MAX_CHUNKS = 3;
/** 低于这个重要性连 inbox 都不进（主进程还会再判一次，这里先省一次 IO）。 */
const MIN_IMPORTANCE = 4;

const log = (msg: string) => {
  try {
    process.stderr.write(`[mpi-memory] ${msg}\n`);
  } catch {
    /* ignore */
  }
};

function configured(): boolean {
  return !!INBOX;
}

function ensureInbox(): void {
  try {
    mkdirSync(INBOX, { recursive: true });
  } catch {
    /* 交给写入时的报错路径 */
  }
}

// ---------------------------------------------------------------------------
// 对话读取
// ---------------------------------------------------------------------------

interface Turn {
  role: "user" | "assistant";
  text: string;
  id: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** 从 ctx.sessionManager 取 entry 列表（拿不到就返回空）。 */
function entriesOf(ctx: any): any[] {
  try {
    const es = ctx?.sessionManager?.getEntries?.();
    return Array.isArray(es) ? es : [];
  } catch {
    return [];
  }
}

function turnsOf(entries: any[]): Turn[] {
  const out: Turn[] = [];
  for (const e of entries) {
    if (!e || e.type !== "message") continue;
    const m = e.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const t = textOf(m.content).trim();
    if (!t) continue;
    out.push({ role: m.role, text: t.slice(0, MSG_MAX_CHARS), id: String(e.id || "") });
  }
  return out;
}

function sessionKey(ctx: any): string {
  let s = "";
  try {
    s = String(ctx?.sessionManager?.getSessionFile?.() || SESSION_FILE || "ephemeral");
  } catch {
    s = SESSION_FILE || "ephemeral";
  }
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

function cursorPath(ctx: any): string {
  return join(INBOX, `.cursor-${sessionKey(ctx)}.json`);
}

function readCursor(ctx: any): string | null {
  try {
    const j = JSON.parse(readFileSync(cursorPath(ctx), "utf8")) as { lastId?: string };
    return typeof j.lastId === "string" ? j.lastId : null;
  } catch {
    return null;
  }
}

function writeCursor(ctx: any, lastId: string): void {
  try {
    writeFileSync(cursorPath(ctx), JSON.stringify({ lastId, at: new Date().toISOString() }), "utf8");
  } catch {
    /* 记不住游标最多导致重复抽取（会被判重拦下），不致命 */
  }
}

/** 取"游标之后"的新增对话；游标失效时退回最近 WINDOW_MAX 条。 */
function newTurns(ctx: any): { turns: Turn[]; lastId: string | null } {
  const turns = turnsOf(entriesOf(ctx));
  if (!turns.length) return { turns: [], lastId: null };
  const lastId = readCursor(ctx);
  if (lastId) {
    const i = turns.findIndex((t) => t.id === lastId);
    if (i >= 0) return { turns: turns.slice(i + 1).slice(-WINDOW_MAX), lastId: turns[turns.length - 1].id };
  }
  return { turns: turns.slice(-WINDOW_MAX), lastId: turns[turns.length - 1].id };
}

// ---------------------------------------------------------------------------
// 本机模型：抽取 + 打分；embedding：相关性
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = `你是记忆抽取器。从"对话片段"里挑出**值得长期记住**的条目，只允许四类：
1) 用户偏好与事实（关于用户本人的稳定信息）
2) 行为模式与交互事件（他反复怎么做、怎么要求）
3) 任务状态与项目信息（在做什么、进度、关键决策）
4) 失败经验与解决方案（踩过的坑与解法）

硬性规则：
- 只写对话中**明确出现**的信息，禁止推断、禁止补充背景。
- 不输出：寒暄与客套、一次性临时指令、已经过去且不再相关的动作、代码或文件内容本身、能用工具现场查到的事实（如某文件有多少行）。
- 每条一句话且**自足**：脱离上下文也看得懂，不要出现"它/这个/刚才那个"这类指代。
- importance 1-10：1-3 琐事（默认不要输出）；4-6 有用但一般；7-8 重要决定或稳定偏好；9-10 硬规则或严重教训。
- 宁缺毋滥：没有值得记的就返回空数组。

只输出 JSON，不要解释、不要 markdown 代码块：
{"memories":[{"text":"...","type":"semantic|episodic|procedural","temporal":"retrospective|present|prospective","importance":7,"reason":"为什么值得记"}]}`;

/** 从模型回复里抠出 JSON（容忍代码块包裹与前后废话）。 */
function parseJsonLoose(raw: string): any | null {
  const cleaned = raw.replace(/```json/gi, "```").trim();
  const fence = /```([\s\S]*?)```/.exec(cleaned);
  const body = fence ? fence[1] : cleaned;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 调本机模型。
 * ⚠️ 本机 qwen3.8-27b 是**推理模型**：思考放在 `reasoning_content`、答案放在 `content`。
 *    若 max_tokens 给小了，token 会被思考吃光、`content` 返回空串（实测踩过：抽取返回空、
 *    打分只给 16 token 必然失败）。所以：①预算给足 ②拿不到 content 时从 reasoning 里兜
 * ③记 finish_reason 便于排障。
 */
async function chat(system: string, user: string, maxTokens = 3000): Promise<string> {
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const j = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
  };
  const choice = j.choices?.[0];
  const content = (choice?.message?.content ?? "").trim();
  if (content) return content;
  const reasoning = (choice?.message?.reasoning_content ?? "").trim();
  if (choice?.finish_reason === "length") {
    log(`模型输出被 max_tokens(${maxTokens}) 截断（reasoning 占满），已尝试从思考内容里兜答案`);
  }
  return reasoning;
}

async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { embedding?: number[] }[] };
    return j.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Extracted {
  text: string;
  type: string;
  temporal: string;
  importance: number;
  reason?: string;
}

/** 把长窗口切成若干段（按空行边界切，保留最近 EXTRACT_MAX_CHUNKS 段）。 */
export function chunkWindow(w: string, max = EXTRACT_CHUNK_CHARS): string[] {
  if (w.length <= max) return [w];
  const parts: string[] = [];
  let cur = "";
  for (const block of w.split("\n\n")) {
    if (cur && (cur.length + block.length + 2) > max) {
      parts.push(cur);
      cur = block;
    } else {
      cur = cur ? `${cur}\n\n${block}` : block;
    }
  }
  if (cur) parts.push(cur);
  return parts.slice(-EXTRACT_MAX_CHUNKS);
}

async function extract(window: string): Promise<Extracted[]> {
  const raw = await chat(EXTRACT_SYSTEM, `对话片段：\n\n${window}`);
  const j = parseJsonLoose(raw);
  const arr = Array.isArray(j?.memories) ? j.memories : [];
  const out: Extracted[] = [];
  for (const m of arr) {
    if (!m || typeof m.text !== "string") continue;
    const text = m.text.trim();
    if (text.length < 6) continue;
    const importance = Number(m.importance);
    out.push({
      text,
      type: typeof m.type === "string" ? m.type : "semantic",
      temporal: typeof m.temporal === "string" ? m.temporal : "retrospective",
      importance: Number.isFinite(importance) ? importance : 5,
      reason: typeof m.reason === "string" ? m.reason : undefined,
    });
  }
  return out;
}

/** 把命中写进 inbox（每条一个 JSON）。 */
function enqueue(items: Array<Record<string, unknown>>): number {
  ensureInbox();
  let n = 0;
  const stamp = Date.now();
  for (const [i, it] of items.entries()) {
    try {
      const name = `${stamp}-${process.pid}-${i}-${createHash("sha1").update(String(it.text)).digest("hex").slice(0, 8)}.json`;
      writeFileSync(join(INBOX, name), JSON.stringify(it, null, 1), "utf8");
      n++;
    } catch (e) {
      log(`写候选失败：${(e as Error).message}`);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 池子读取（/memory 命令用）
//
// 扩展 import 不到本仓模块，所以这里自包含地读**文件真相源**。
// 只解析展示需要的几个字段（不做完整校验）——完整校验在 main 侧的 memory-inbox.ts。
// 检索是字面的（包含匹配 + 时间排序）；语义召回由 MPI 侧的 zvec 索引负责。
// ---------------------------------------------------------------------------

const POOL_DIR = process.env.MPI_MEMORY_POOL_DIR || "";

interface PoolCard {
  id: string;
  text: string;
  importance: number;
  type: string;
  temporal: string;
  project: string;
  recurrence: number;
  createdAt: string;
  path: string;
}

function walkMd(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 3) return out;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    if (name.endsWith(".md")) out.push(p);
    else walkMd(p, out, depth + 1);
  }
  return out;
}

/** 解析一条池文件（容错：拿不准的字段给缺省值，不在展示路径上抛错）。 */
export function parsePoolFile(raw: string, path: string): PoolCard | null {
  const norm = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(norm.trimStart());
  if (!m) return null;
  const field = (k: string): string => {
    const r = new RegExp(`^${k}\\s*:\\s*(.*)$`, "m").exec(m[1]);
    if (!r) return "";
    return r[1].trim().replace(/^"(.*)"$/, "$1");
  };
  const body = norm.trimStart().slice(m[0].length).replace(/<!--[\s\S]*?-->/g, "");
  const text = body.split(/\n##\s/)[0].trim();
  if (!text) return null;
  return {
    id: field("id"),
    text,
    importance: Number(field("importance")) || 0,
    type: field("type") || "-",
    temporal: field("temporal") || "-",
    project: field("project") || "-",
    recurrence: Number(field("recurrence")) || 1,
    createdAt: field("created_at"),
    path,
  };
}

/** 读池子（inbox + proposals），按创建时间倒序。 */
export function readPool(poolDir: string): PoolCard[] {
  if (!poolDir) return [];
  const cards: PoolCard[] = [];
  for (const p of walkMd(join(poolDir, "inbox"))) {
    try {
      const c = parsePoolFile(readFileSync(p, "utf8"), p);
      if (c) cards.push(c);
    } catch {
      /* 单条坏了不影响列其它 */
    }
  }
  cards.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return cards;
}

/** 字面检索（包含匹配 + 关键词覆盖）。与 MPI 侧的语义召回互补。 */
export function searchPool(cards: PoolCard[], query: string, limit = 10): PoolCard[] {
  const q = query.trim().toLowerCase();
  if (!q) return cards.slice(0, limit);
  const terms = q.split(/[\s，,、]+/).filter((t) => t.length > 1);
  const scored = cards.map((c) => {
    const t = c.text.toLowerCase();
    let score = t.includes(q) ? 1 : 0;
    for (const term of terms) if (t.includes(term)) score += 0.3;
    // 重要性与复现次数轻微加权（不盖过文字命中）
    score += c.importance / 100 + c.recurrence / 100;
    return { c, score };
  });
  return scored
    .filter((s) => s.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.c);
}

// ---------------------------------------------------------------------------
// 语义召回：走主进程的本地端点（拿不到就降级为字面检索）
//
// 为什么绕这一下：扩展自包含、import 不到本仓的 zvec 索引；主进程才是索引的持有者。
// 端点信息（url + token）每次都从 env 指定的文件现读——主进程重启换端口也能跟上。
// ---------------------------------------------------------------------------

const ENDPOINT_FILE = process.env.MPI_MEMORY_ENDPOINT_FILE || "";

interface RecallHit {
  id: string;
  score: number;
  text: string;
  importance: number;
  type: string;
  temporal: string;
  project: string;
  createdAt: string;
}

function endpointInfo(): { url: string; token: string } | null {
  if (!ENDPOINT_FILE) return null;
  try {
    const j = JSON.parse(readFileSync(ENDPOINT_FILE, "utf8"));
    if (typeof j?.url === "string" && typeof j?.token === "string") return { url: j.url, token: j.token };
    return null;
  } catch {
    return null; // 端点没起（终端 pi / MPI 未运行）——正常降级，不报错
  }
}

/** 返回语义召回结果；拿不到端点或请求失败时返回 null（交由调用方降级）。 */
async function remoteRecall(text: string, topK = 5): Promise<{ kind: string; hits: RecallHit[] } | null> {
  const ep = endpointInfo();
  if (!ep) return null;
  try {
    const res = await fetch(`${ep.url}/recall`, {
      method: "POST",
      headers: { "x-mpi-memory-token": ep.token, "Content-Type": "application/json" },
      body: JSON.stringify({ text, topK }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { indexKind?: string; hits?: RecallHit[] };
    if (!Array.isArray(j.hits)) return null;
    return { kind: j.indexKind || "unknown", hits: j.hits };
  } catch {
    return null;
  }
}

/** 把召回结果渲染成给模型看的文本（短、可扫读、带来源）。 */
export function formatHits(source: string, hits: RecallHit[]): string {
  if (!hits.length) return "记忆池里没有相关的记忆。";
  const lines = hits.map((h, i) => {
    const when = h.createdAt ? h.createdAt.slice(0, 10) : "";
    const meta = [h.type, `重要性 ${h.importance}`, when, h.project].filter(Boolean).join(" · ");
    return `${i + 1}. [${h.score.toFixed(3)}] ${h.text}\n   （${meta}）`;
  });
  return `命中的记忆（${source}，共 ${hits.length} 条）：\n${lines.join("\n")}`;
}

function agoLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 把一条池子条目渲染成可展开卡片（label 短、detail 全）。 */
function cardOption(c: PoolCard): { label: string; detail: string } {
  const meta = [`重要性 ${c.importance}`, c.type, c.temporal, c.project, `复现 ${c.recurrence}`]
    .filter(Boolean)
    .join(" · ");
  const when = agoLabel(c.createdAt);
  return {
    label: `${when ? when + " · " : ""}${c.text.slice(0, 46)}${c.text.length > 46 ? "…" : ""}`,
    detail: `${c.text}\n\n${meta}\n${c.id}\n${c.path}`,
  };
}

// ---------------------------------------------------------------------------
// 捕获主流程：快照（同步、极快） + 抽取（后台、异步）
//
// ⚠️ 为什么拆成两段：pi 会 await 这些钩子（session_before_compact 甚至能返回自定义摘要），
//    而在钩子里跑一次 30s 级的本机模型调用会把**压缩/退出**卡住。
//    所以钩子只做「把新增对话快照进 .pending-*.json」（纯文件写，毫秒级），
//    抽取交给定时器在后台做；上次没跑完的遗留快照，下次 session_start 时回收。
// ---------------------------------------------------------------------------

function pendingPath(ctx: any): string {
  return join(INBOX, `.pending-${sessionKey(ctx)}.json`);
}

/** 钩子里的唯一动作：把游标之后的新增对话写成快照（不调模型）。 */
function snapshot(ctx: any, reason: string): void {
  if (!configured()) return;
  try {
    const { turns, lastId } = newTurns(ctx);
    if (turns.length < 2) return;
    const window = turns.map((t) => `【${t.role === "user" ? "用户" : "助手"}】${t.text}`).join("\n\n");
    if (window.length < 60) return;

    const p = pendingPath(ctx);
    let list: Array<Record<string, unknown>> = [];
    try {
      const prev = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(prev)) list = prev;
    } catch {
      /* 没有或坏了就重开 */
    }
    list.push({ reason, window, at: new Date().toISOString() });
    if (list.length > 2) list = list.slice(-2); // 只留最近两段，避免越攒越大
    ensureInbox();
    writeFileSync(p, JSON.stringify(list), "utf8");
    if (lastId) writeCursor(ctx, lastId);
  } catch (e) {
    log(`快照(${reason})失败（已忽略）：${(e as Error).message}`);
  }
}

let sweeping = false;

/** 处理一段窗口：抽取 → 打分 → 入队。长窗口自动分段（每段一次调用）。 */
async function processWindow(window: string, reason: string): Promise<number> {
  const found: Extracted[] = [];
  for (const [i, chunk] of chunkWindow(window).entries()) {
    try {
      const part = await extract(chunk);
      found.push(...part);
      if (part.length === 0 && chunk.length > 600) {
        log(`抽取(${reason})第 ${i + 1} 段返回空——本机模型可能把 token 烧在思考上（窗口 ${chunk.length} 字符）`);
      }
    } catch (e) {
      log(`抽取(${reason})第 ${i + 1} 段失败（已跳过）：${(e as Error).message}`);
    }
  }
  // 同一件事可能在多段里重复出现 → 段内去重（正文字面相同即算同一条）
  const unique = new Map<string, Extracted>();
  for (const m of found) {
    const key = m.text.replace(/\s+/g, "");
    const prev = unique.get(key);
    if (!prev || m.importance > prev.importance) unique.set(key, m);
  }
  const all = [...unique.values()];
  const keep = all.filter((m) => m.importance >= MIN_IMPORTANCE);
  if (!keep.length) {
    log(`抽取(${reason})：没有达标条目（抽出 ${all.length} 条）`);
    return 0;
  }
  const context = window.slice(-CONTEXT_MAX_CHARS);
  const ctxVec = await embed(context);
  const items: Array<Record<string, unknown>> = [];
  for (const m of keep) {
    let relevance = 0.7; // 无法算相似度时的中性缺省（不是捏造的精度）
    if (ctxVec) {
      const v = await embed(m.text);
      if (v) relevance = Math.max(0, Math.min(1, cosine(v, ctxVec)));
    }
    items.push({
      text: m.text,
      type: m.type,
      temporal: m.temporal,
      importance: m.importance,
      relevance,
      project: process.env.MPI_MEMORY_PROJECT || basename(process.cwd()) || "global",
        projectRoot: process.cwd(),
      source: `ext:${reason}:${new Date().toISOString()}`,
      reason: m.reason,
      capturedAt: new Date().toISOString(),
    });
  }
  const n = enqueue(items);
  log(`抽取(${reason})：抽出 ${all.length} 条，入队 ${n} 条`);
  return n;
}

/** 后台清扫：处理 inbox 里所有 .pending-*.json 快照。 */
async function sweep(): Promise<void> {
  if (!configured() || sweeping) return;
  sweeping = true;
  try {
    let files: string[] = [];
    try {
      files = readdirSync(INBOX).filter((f) => f.startsWith(".pending-") && f.endsWith(".json"));
    } catch {
      return;
    }
    for (const f of files) {
      const p = join(INBOX, f);
      let list: Array<{ window?: string; reason?: string }> = [];
      try {
        const parsed = JSON.parse(readFileSync(p, "utf8"));
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        rmSync(p, { force: true });
        continue;
      }
      for (const item of list) {
        if (typeof item?.window === "string" && item.window.length > 60) {
          await processWindow(item.window, String(item.reason || "pending"));
        }
      }
      rmSync(p, { force: true });
    }
  } catch (e) {
    log(`后台抽取异常（已忽略）：${(e as Error).message}`);
  } finally {
    sweeping = false;
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
/** 安排一次后台抽取（合并多次触发）。 */
function scheduleSweep(delayMs = 2500): void {
  if (sweepTimer) return;
  const t = setTimeout(() => {
    sweepTimer = null;
    void sweep();
  }, delayMs);
  t.unref?.();
  sweepTimer = t;
}

const NoteParams = Type.Object({
  text: Type.String({ description: "The fact/preference/lesson to remember, one self-contained sentence." }),
  type: Type.Optional(Type.String({ description: "semantic | episodic | procedural (default semantic)" })),
  temporal: Type.Optional(Type.String({ description: "retrospective | present | prospective (default retrospective)" })),
  importance: Type.Optional(Type.Number({ description: "1-10; omit to let the local model decide" })),
});

export default function (pi: ExtensionAPI) {
  if (!configured()) {
    log("未配置 MPI_MEMORY_INBOX_DIR —— 记忆捕获已停用");
    return;
  }

  // 主通道：一轮彻底结束（pi 不会再自动继续）。只快照，抽取留给后台。
  pi.on("agent_settled", (_event, ctx) => {
    snapshot(ctx, "settled");
    scheduleSweep();
  });

  // 防丢失：压缩前先落快照（压缩会改变模型可见上下文）
  pi.on("session_before_compact", (_event, ctx) => {
    snapshot(ctx, "pre-compact");
    scheduleSweep(800);
  });

  // 收尾（quit/reload/new/resume/fork）：只快照，绝不在这里等模型
  pi.on("session_shutdown", (_event, ctx) => {
    snapshot(ctx, "shutdown");
  });

  // 会话开始：回收上次遗留的快照（进程退出时没来得及抽取的那些）
  pi.on("session_start", () => {
    scheduleSweep(1500);
  });

  // ---- 斜杠命令族（一操作一命令，对标 mem0 的 remember/search/forget/status/tour）----
  //
  // /memory 是总入口（add/list/find）；下面这组是**低层直给**，脚本化/肌肉记忆更好用：
  //   /memory-remember <内容>   原文直存（不改写、不推断）
  //   /memory-search <关键词>   语义检索（端点不可用时字面降级）
  //   /memory-tour              浏览全部（按时间倒序，分页）
  //   /memory-status            池子/索引/端点/收件箱 一览
  //   /memory-forget <id|词>    归档一条（二次确认；归档 ≠ 删除）


  /** 补全项（AutocompleteItem 的结构，不引类型依赖：扩展是自包含的）。 */
  const ac = (value: string, label: string) => ({ value, label });
  /** 按前缀过滤补全项；无匹配返回 null（pi 会当作没有补全）。 */
  const acFilter = (items: { value: string; label: string }[], prefix: string) => {
    const p = prefix.trim().toLowerCase();
    const hit = p ? items.filter((i) => i.value.toLowerCase().startsWith(p) || i.label.toLowerCase().includes(p)) : items;
    return hit.length ? hit : null;
  };
  /**
   * 补全专用：带 5 秒缓存的池子读取。
   * 补全是**每敲一个键**都会调的，而 readPool 要遍历目录（1000 条实测 ~167ms）——
   * 不加缓存会明显拖慢输入。
   */
  let poolCache: { at: number; cards: PoolCard[] } | null = null;
  const readPoolCached = (): PoolCard[] => {
    const now = Date.now();
    if (!poolCache || now - poolCache.at > 5000) poolCache = { at: now, cards: readPool(POOL_DIR) };
    return poolCache.cards;
  };
  /** 池内条目 → 补全项（/memory-forget 用：不必记 id）。 */
  const cardCompletions = (prefix: string) =>
    acFilter(
      readPoolCached().map((c) => ac(c.id, `${c.text.slice(0, 40)}　[${c.id.slice(0, 8)}]`)),
      prefix,
    );

  /** 检索：语义优先，端点不在就字面降级（两条路都会在标题里说明来源）。 */
  async function doSearch(ctx: any, query: string, cards: PoolCard[]): Promise<void> {
    const remote = await remoteRecall(query, 10);
    if (remote) {
      if (!remote.hits.length) {
        ctx.ui.notify(`记忆池里没找到与「${query}」相关的条目（共 ${cards.length} 条，索引 ${remote.kind}）。`, "info");
        return;
      }
      await ctx.ui.select(
        `记忆池 · 「${query}」语义命中 ${remote.hits.length} 条（共 ${cards.length}）`,
        remote.hits.map((h) => ({
          label: `${h.score.toFixed(3)} · ${h.text.slice(0, 40)}${h.text.length > 40 ? "…" : ""}`,
          detail: `${h.text}

重要性 ${h.importance} · ${h.type} · ${h.temporal}
${h.project} · ${h.createdAt}
${h.id}`,
        })),
      );
      return;
    }
    const local = searchPool(cards, query);
    if (!local.length) {
      ctx.ui.notify(`记忆池里没找到与「${query}」相关的条目（字面检索，共 ${cards.length} 条）。`, "info");
      return;
    }
    await ctx.ui.select(`记忆池 · 「${query}」字面命中 ${local.length} 条（语义端点不可用）`, local.map(cardOption));
  }

  /** 写入：一条候选丢进 inbox（主进程负责落盘）。 */
  async function doRemember(ctx: any, text: string, opts: { verbatim?: boolean; from?: string } = {}): Promise<void> {
    let importance = 6;
    let scoringFailed = false;
    try {
      const scored = await chat(
        `给这条要记住的信息打 1-10 分的重要性（1=琐事，10=极重）。最后一行只输出一个数字。`,
        text,
        600,
      );
      const nums = [...scored.matchAll(/\b(10|[1-9])\b/g)];
      importance = nums.length ? Number(nums[nums.length - 1][1]) : 6;
    } catch {
      scoringFailed = true; // fail-open：打分失败也要记下，交人工复核
    }
    const n = enqueue([
      {
        text,
        type: "semantic",
        temporal: /以后|下次|不要再|必须/.test(text) ? "prospective" : "retrospective",
        importance,
        relevance: 0.9, // 手动记录 = 与当前关切高度相关
        project: process.env.MPI_MEMORY_PROJECT || basename(process.cwd()) || "global",
          projectRoot: process.cwd(),
        source: `${opts.verbatim ? "cmd-remember" : "cmd"}:${sessionKey(ctx)}`,
        scoringFailed,
        capturedAt: new Date().toISOString(),
      },
    ]);
    ctx.ui.notify(
      n
        ? `${opts.verbatim ? "已原文记入" : "已记入"}记忆池（重要性 ${importance}${scoringFailed ? "，打分失败已标记" : ""}），主进程稍后落盘。`
        : "写入记忆池失败，请看日志。",
      n ? "info" : "error",
    );
  }

  pi.registerCommand("memory", {
    description: "记忆池总入口：/memory <内容> 记一条；/memory 浏览；/memory find <关键词> 查找",
    getArgumentCompletions: (prefix: string) =>
      acFilter([ac("list", "list　浏览最近条目"), ac("find ", "find <关键词>　语义检索")], prefix),
    handler: async (args: string, ctx: any) => {
      const raw = String(args || "").trim();
      const cards = readPool(POOL_DIR);
      const findMatch = /^(find|search)\s+(.*)$/i.exec(raw);
      if (raw && !/^(list|ls|find|search)\b/i.test(raw)) {
        ctx.ui.notify("正在评分并写入记忆池…", "info");
        await doRemember(ctx, raw);
        return;
      }
      if (findMatch) {
        await doSearch(ctx, findMatch[2], cards);
        return;
      }
      const list = cards.slice(0, 20);
      if (!list.length) {
        ctx.ui.notify(
          cards.length ? `记忆池共 ${cards.length} 条。` : "记忆池还是空的（自动捕获会往里面沉淀，也可用 /memory <内容> 手记）。",
          "info",
        );
        return;
      }
      await ctx.ui.select(`记忆池 · ${cards.length} 条（显示最近 ${list.length}）`, list.map(cardOption));
    },
  });

  pi.registerCommand("memory-remember", {
    description: "原文存入记忆池（不改写、不推断）：/memory-remember <内容>",
    handler: async (args: string, ctx: any) => {
      const text = String(args || "").trim();
      if (!text) {
        ctx.ui.notify("用法：/memory-remember <要记住的内容>", "error");
        return;
      }
      ctx.ui.notify("正在评分并写入记忆池…", "info");
      await doRemember(ctx, text, { verbatim: true });
    },
  });

  pi.registerCommand("memory-search", {
    description: "检索记忆池（语义优先，端点不可用时字面降级）：/memory-search <关键词或问题>",
    // 候选直接来自池子正文前几个字，省得想关键词
    getArgumentCompletions: (prefix: string) => {
      const cards = readPoolCached().slice(0, 20);
      const items = cards.map((c) => ac(c.text.slice(0, 12), c.text.slice(0, 40)));
      return acFilter(items, prefix);
    },
    handler: async (args: string, ctx: any) => {
      const q = String(args || "").trim();
      if (!q) {
        ctx.ui.notify("用法：/memory-search <关键词或问题>", "error");
        return;
      }
      await doSearch(ctx, q, readPool(POOL_DIR));
    },
  });

  pi.registerCommand("memory-tour", {
    description: "浏览记忆池全部条目（按时间倒序）：/memory-tour [数量]",
    getArgumentCompletions: (prefix: string) =>
      acFilter([ac("10", "10 条"), ac("30", "30 条"), ac("50", "50 条"), ac("100", "100 条")], prefix),
    handler: async (args: string, ctx: any) => {
      const cards = readPool(POOL_DIR);
      if (!cards.length) {
        ctx.ui.notify("记忆池还是空的。", "info");
        return;
      }
      const n = Math.max(1, Math.min(200, Number(String(args || "").trim()) || 30));
      await ctx.ui.select(`记忆池 · 共 ${cards.length} 条（显示 ${Math.min(n, cards.length)} 条）`, cards.slice(0, n).map(cardOption));
    },
  });

  pi.registerCommand("memory-status", {
    description: "记忆池状态：条数 / 索引 / 语义端点 / 待处理候选",
    handler: async (_args: string, ctx: any) => {
      const cards = readPool(POOL_DIR);
      const newest = cards[0]?.createdAt ? `${agoLabel(cards[0].createdAt)}（${cards[0].createdAt.slice(0, 16)}）` : "无";
      // 端点健康（拿不到就当没起，不报错）
      let indexKind = "未启用（字面检索）";
      let poolCount = String(cards.length);
      const ep = endpointInfo();
      if (ep) {
        try {
          const r = await fetch(`${ep.url}/health`, {
            headers: { "x-mpi-memory-token": ep.token },
            signal: AbortSignal.timeout(3000),
          });
          if (r.ok) {
            const j = (await r.json()) as { indexKind?: string; count?: number };
            indexKind = String(j.indexKind ?? "未知");
            poolCount = String(j.count ?? cards.length);
          }
        } catch {
          indexKind = "端点无响应";
        }
      }
      // 待处理候选（主进程 2 秒内会消费掉，通常为 0）
      let pending = 0;
      try {
        pending = readdirSync(INBOX).filter((f) => !f.startsWith(".") && f.endsWith(".json")).length;
      } catch {
        /* inbox 不存在 */
      }
      // 提案与回执（P3）："提交了但没反应"一直是最吓人的体验，把结果摆在这里
      const props = readProposals();
      const propsPending = props.filter((p) => p.status === "pending").length;
      const latest = props.find((p) => p.status === "pending");
      const results = readOpResults(3);
      await ctx.ui.select("记忆池状态", [
        { label: `池内条目：${poolCount}`, detail: `池目录：${POOL_DIR || "(未配置)"}` },
        { label: `检索索引：${indexKind}`, detail: `语义端点：${ep ? ep.url : "未启动（终端 pi 或 MPI 未运行）"}` },
        {
          label: `提案：待审批 ${propsPending} / 共 ${props.length}`,
          detail: [
            latest ? `最新：${latest.title}（/memory-approve ${latest.id.slice(-6)}）` : "没有待审批的提案。",
            `跑一次分诊：/memory-dream　查看全部：/memory-proposals`,
            ...props.slice(0, 5).map((p) => `  ${STATUS_TAG[p.status] ?? p.status} · ${p.title}`),
          ].join("\n"),
        },
        { label: `最新一条：${newest}`, detail: cards[0]?.text ?? "" },
        { label: `待处理候选：${pending}`, detail: `收件箱：${INBOX || "(未配置)"}` },
        {
          label: `最近操作回执：${results.length} 条`,
          detail: results.length
            ? results.map((r) => `${r.ok ? "✅" : "❌"} ${r.at.slice(11, 19)} ${r.op}：${r.detail}`).join("\n")
            : "暂无（归档/批准/分诊的结果会记在这里）",
        },
      ]);
    },
  });

  pi.registerCommand("memory-forget", {
    description: "归档一条记忆（不是删除，可在 archive/ 里找回）：/memory-forget <id 前缀或正文片段>",
    getArgumentCompletions: cardCompletions,
    handler: async (args: string, ctx: any) => {
      const needle = String(args || "").trim();
      if (!needle) {
        ctx.ui.notify("用法：/memory-forget <id 前缀或正文片段>", "error");
        return;
      }
      const cards = readPool(POOL_DIR);
      const target =
        cards.find((c) => c.id.startsWith(needle)) ?? cards.find((c) => c.text.includes(needle)) ?? null;
      if (!target) {
        ctx.ui.notify(`记忆池里找不到匹配「${needle}」的条目。`, "error");
        return;
      }
      // 破坏性操作 → 二次确认（且实际动作是"归档"而非删除，仍然要问）
      const okToGo = await ctx.ui.confirm(
        "归档这条记忆？",
        `${target.text}

（移到 archive/，不是删除，之后可找回）`,
      );
      if (!okToGo) {
        ctx.ui.notify("已取消。", "info");
        return;
      }
      const n = enqueue([{ op: "forget", id: target.id, reason: `cmd-forget:${sessionKey(ctx)}` }]);
      ctx.ui.notify(n ? "归档请求已提交，主进程稍后处理（约 2 秒）。" : "提交失败，请看日志。", n ? "info" : "error");
    },
  });

  // ---- 巩固（P3）：分诊 / 提案 / 审批 ---------------------------------------
  //
  // /memory-dream      跑一次周期分诊（本地模型 1-2 分钟，产出提案，不直接改任何东西）
  // /memory-proposals  看提案列表（待审批的排前面）
  // /memory-approve    批准一份提案（会真落地：写 lesson / 归档）
  // /memory-reject     拒绝一份提案（留痕，可事后查）

  interface ProposalCard {
    id: string;
    kind: string;
    status: string;
    title: string;
    entries: string[];
    reason: string;
    target: string;
    result: string;
    /** 拟落的正文（截断），审提案时要能看见内容本身 */
    body: string;
  }

  /** 轻量读提案（展示用；完整校验在主进程侧）。 */
  function readProposals(): ProposalCard[] {
    const dir = join(POOL_DIR, "proposals");
    const out: ProposalCard[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      return out;
    }
    for (const name of names) {
      try {
        const raw = readFileSync(join(dir, name), "utf8");
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
        const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim() ?? "";
        out.push({
          id: field("id"),
          kind: field("kind"),
          status: field("status"),
          title: field("title"),
          entries: field("entries") ? field("entries").split(",").filter(Boolean) : [],
          reason: /^>\s*理由：(.+)$/m.exec(raw)?.[1]?.trim() ?? "",
          target: field("target"),
          result: field("result"),
          // 正文 = 去掉 frontmatter、标题行、> 引用行之后的剩余部分
          body: raw
            .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
            .replace(/^#\s.+$/m, "")
            .replace(/^>.*$/gm, "")
            .trim(),
        });
      } catch {
        /* 坏文件跳过：完整报错由面板/CLI 负责 */
      }
    }
    // 待审批优先，其余按 id（ULID = 时间序）倒序
    const rank = (s: string) => (s === "pending" ? 0 : s === "approved" ? 1 : 2);
    return out.sort((a, b) => rank(a.status) - rank(b.status) || (a.id < b.id ? 1 : -1));
  }

  const KIND_TAG: Record<string, string> = {
    "promote-kb": "→ 知识库",
    "promote-inject": "→ 常驻注入",
    "promote-now": "→ 当前任务",
    archive: "→ 归档",
  };

  /** 读最近几条 op 回执（主进程写的 ops.jsonl）。缺文件/坏行都当没有，绝不报错。 */
  function readOpResults(n: number): { at: string; op: string; ok: boolean; detail: string }[] {
    try {
      const lines = readFileSync(join(POOL_DIR, "ops.jsonl"), "utf8").split("\n").filter(Boolean);
      return lines
        .slice(-n)
        .map((l) => {
          const j = JSON.parse(l) as { at?: string; op?: string; ok?: boolean; detail?: string };
          return {
            at: String(j.at ?? ""),
            op: String(j.op ?? "?"),
            ok: j.ok !== false,
            detail: String(j.detail ?? ""),
          };
        })
        .reverse();
    } catch {
      return [];
    }
  }

  const STATUS_TAG: Record<string, string> = {
    pending: "待审批",
    approved: "已批准（待人工合并）",
    rejected: "已拒绝",
    applied: "已落地",
    failed: "失败",
  };

  /** 提案的按钮文案（同时用于选择列表，以及"点了一下之后"回找提案）。 */
  const proposalOption = (p: ProposalCard) => ({
    label: `${STATUS_TAG[p.status] ?? p.status} · ${KIND_TAG[p.kind] ?? p.kind} · ${p.title}`,
    detail: [
      `提案 ${p.id.slice(-8)}`,
      `去向：${KIND_TAG[p.kind] ?? p.kind}`,
      p.target ? `目标：${p.target}` : null,
      `理由：${p.reason}`,
      `依据条目：${p.entries.join(" ")}`,
      p.result ? `结果：${p.result}` : null,
      `文件：${join(POOL_DIR, "proposals", `${p.id}.md`)}`,
      "",
      p.body
        ? ["── 正文 ──", p.body.slice(0, 1200) + (p.body.length > 1200 ? "\n…（截断，完整内容看上面的文件）" : "")].join("\n")
        : "（无正文：归档类不需要）",
      "",
      "点这一条 → 直接选「批准 / 拒绝」（不用敲 id）",
    ]
      .filter((x) => x !== null)
      .join("\n"),
  });

  /** 批准一份提案（确认卡片 + enqueue）。 */
  async function approveFlow(ctx: any, p: ProposalCard): Promise<void> {
    if (p.status !== "pending" && p.status !== "failed") {
      ctx.ui.notify(`这份提案状态是「${STATUS_TAG[p.status] ?? p.status}」，无需再批准。`, "error");
      return;
    }
    const willDo =
      p.kind === "archive"
        ? `把 ${p.entries.length} 条记忆移到归档目录（归档≠删除，可找回）`
        : p.kind === "promote-kb"
          ? `写入 ${p.target || "项目知识库（目标未定，可能失败）"}（不自动 commit，留给你 git diff 审）`
          : "标记为已批准，你自己合并进长期内容（不会自动改画像/约定）";
    const warn = bodyIsRawFallback(p)
      ? "\n\n⚠️ 这份提案的 lesson 正文还没生成（正文是条目原文）。现在批准会写出一份粗糙文档；建议先拒绝，下一次 /memory-dream 会重新生成。"
      : "";
    const go = await ctx.ui.confirm(`批准「${p.title}」？`, `${willDo}${warn}

依据条目 ${p.entries.length} 条`);
    if (!go) {
      ctx.ui.notify("已取消。", "info");
      return;
    }
    const n = enqueue([{ op: "approve", id: p.id, reason: `approve:${sessionKey(ctx)}` }]);
    ctx.ui.notify(n ? "批准请求已提交，主进程稍后执行（约 2 秒，结果见 /memory-status）。" : "提交失败。", n ? "info" : "error");
  }

  /** 拒绝一份提案（留痕）。 */
  async function rejectFlow(ctx: any, p: ProposalCard): Promise<void> {
    const n = enqueue([{ op: "reject", id: p.id, reason: `reject:${sessionKey(ctx)}` }]);
    ctx.ui.notify(n ? `已拒绝「${p.title}」（状态改动约 2 秒后生效）。` : "提交失败。", n ? "info" : "error");
  }

  /**
   * 弹出提案列表让人点选（三处命令共用同一套逻辑）。
   * 关键：MPI 选择卡片回传的是 **label 字符串**（见 ExtUiPromptCard 的 respond({value: label})），
   * 所以用 label 与选项一一对应回找，不靠索引、不靠对象引用。
   * 为什么归一到一处：label 回找逻辑分三份写，迟早有一处忘了改（真发生过一次）。
   */
  async function pickProposal(ctx: any, list: ProposalCard[], title: string): Promise<ProposalCard | null> {
    if (!list.length) {
      ctx.ui.notify("没有可选的提案。可用 /memory-dream 跑一次分诊。", "info");
      return null;
    }
    const shown = list.slice(0, 30);
    const options = shown.map(proposalOption);
    const picked = await ctx.ui.select(title, options);
    if (!picked) return null;
    const idx = options.findIndex((o) => o.label === picked);
    if (idx < 0) {
      ctx.ui.notify("没能对上你选的那条，改用 /memory-approve <id 后 8 位>。", "error");
      return null;
    }
    return shown[idx];
  }

  /**
   * 点了一份提案之后干什么。
   * 为什么要有这一步：让人去敲 26 位 ULID 是大忌（真发生过）——
   * 列表 → 点一条 → 直接选动作，全程不打 id。
   * ⚠️ MPI 选择卡片回传的是 **label 字符串**（见 ExtUiPromptCard 的 respond({value: label})），
   * 所以这里用 label 与选项一一对应，不靠索引或对象引用。
   */
  async function proposalActionMenu(ctx: any, p: ProposalCard): Promise<void> {
    const actionable = p.status === "pending" || p.status === "failed";
    const labels = [
      ...(actionable ? ["批准并落地", "拒绝"] : []),
      "查看完整正文",
      "返回",
    ];
    const picked = await ctx.ui.select(
      `${p.title}
${STATUS_TAG[p.status] ?? p.status} · ${KIND_TAG[p.kind] ?? p.kind}`,
      labels,
    );
    if (!picked || picked === "返回") return;
    if (picked === "查看完整正文") {
      const file = join(POOL_DIR, "proposals", `${p.id}.md`);
      try {
        // 用编辑器展示全文（只读：返回值直接丢掉，不改内容）
        await ctx.ui.editor(`提案 ${p.id.slice(-8)} 正文（只读，直接关掉即可）`, p.body || "（无正文）");
      } catch {
        ctx.ui.notify(`完整正文在文件里：${file}`, "info");
      }
      return;
    }
    if (picked === "拒绝") {
      await rejectFlow(ctx, p);
      return;
    }
    if (picked === "批准并落地") await approveFlow(ctx, p);
  }

  /**
   * 按 id 找提案：支持**前缀或后缀**（人看到的是列表里的末 6 位，不是开头）。
   * 真事故：最初只按前缀匹配，而列表展示的是 id 后 6 位 → 人拄后缀就"找不到提案"。
   * 多个匹配时不猜，报出来让人自己确定——拿错提案去审批比报错危险得多。
   */
  function findProposal(needle: string): ProposalCard | null {
    const all = readProposals();
    const exact = all.find((p) => p.id === needle);
    if (exact) return exact;
    const hits = all.filter((p) => p.id.startsWith(needle) || p.id.endsWith(needle));
    if (hits.length > 1) return null; // 歧义：交给调用方提示
    return hits[0] ?? null;
  }

  /** 该前缀/后缀是否命中多个提案（用于提示歧义）。 */
  function proposalMatches(needle: string): ProposalCard[] {
    return readProposals().filter((p) => p.id === needle || p.id.startsWith(needle) || p.id.endsWith(needle));
  }

  /**
   * 这份提案的正文是不是"没生成出来"（用的是条目原文）？
   * 为什么要在审批前提醒：正文没生成时批准会把原文写成 lesson，得到一份不合格的文档——
   * 人应该先知道，而不是事后才发现 KB 里多了篇半成品。
   */
  function bodyIsRawFallback(p: ProposalCard): boolean {
    if (p.kind !== "promote-kb") return false;
    try {
      const raw = readFileSync(join(POOL_DIR, "proposals", `${p.id}.md`), "utf8");
      const sections = (raw.match(/^#{1,2} /gm) ?? []).length;
      return sections === 1 && !/^lesson:/m.test(raw); // 只有那个 # 标题 = 正文是原文
    } catch {
      return false;
    }
  }

  pi.registerCommand("memory-dream", {
    description: "跑一次周期分诊（产出晋升/归档提案，不直接改任何东西）：/memory-dream [--dry]",
    getArgumentCompletions: (prefix: string) =>
      acFilter([ac("--dry", "--dry　预览：只分诊不落盘")], prefix),
    handler: async (args: string, ctx: any) => {
      const dry = /--dry|--preview/.test(String(args || ""));
      const n = enqueue([{ op: "dream", dryRun: dry, reason: `cmd-dream:${sessionKey(ctx)}` }]);
      ctx.ui.notify(
        n
          ? `已启动周期分诊${dry ? "（预览，不落盘）" : ""}。本地模型要跑 1-2 分钟，完成后用 /memory-proposals 看结果。`
          : "提交失败，请看日志。",
        n ? "info" : "error",
      );
    },
  });

  pi.registerCommand("memory-proposals", {
    description: "列出记忆池提案（待审批优先；点一条即可批准/拒绝）：/memory-proposals",
    handler: async (_args: string, ctx: any) => {
      const all = readProposals();
      const pending = all.filter((p) => p.status === "pending").length;
      const picked = await pickProposal(
        ctx,
        all,
        `提案 · ${all.length} 份（待审批 ${pending}）\n点一条即可直接批准/拒绝（不用敲 id）`,
      );
      if (picked) await proposalActionMenu(ctx, picked);
    },
  });

  pi.registerCommand("memory-approve", {
    description: "批准一份提案并落地（写 lesson / 归档）：/memory-approve <提案 id 前缀或后缀>",
    getArgumentCompletions: (prefix: string) =>
      acFilter(
        readProposals()
          .filter((p) => p.status === "pending" || p.status === "failed")
          // value 用短柄（后 8 位）：选完就是短的一串，不用敲 26 位 ULID
          .map((p) => ac(p.id.slice(-8), `${p.title}　[${KIND_TAG[p.kind] ?? p.kind}]`)),
        prefix,
      ),
    handler: async (args: string, ctx: any) => {
      const needle = String(args || "").trim();
      if (!needle) {
        // 不带参数 = 直接弹待审批列表让人点（手敲 id 是反人性的）
        const list = readProposals().filter((p) => p.status === "pending" || p.status === "failed");
        const picked = await pickProposal(ctx, list, `选择要批准的提案（可批准 ${list.length} 份）`);
        if (picked) await approveFlow(ctx, picked);
        return;
      }
      const p = findProposal(needle);
      if (!p) {
        const hits = proposalMatches(needle);
        ctx.ui.notify(
          hits.length > 1
            ? `「${needle}」匹配到 ${hits.length} 份提案，请多输几位：${hits.map((x) => x.id.slice(-8)).join(" / ")}`
            : `找不到提案：${needle}（用 /memory-proposals 看，前缀/后缀都行）`,
          "error",
        );
        return;
      }
      // 状态检查与"将会发生什么"的确认都在 approveFlow 里（列表点选走同一条路）
      await approveFlow(ctx, p);
    },
  });

  pi.registerCommand("memory-reject", {
    description: "拒绝一份提案（留痕，可事后查）：/memory-reject <提案 id 前缀或后缀>",
    getArgumentCompletions: (prefix: string) =>
      acFilter(
        readProposals()
          .filter((p) => p.status === "pending" || p.status === "failed")
          .map((p) => ac(p.id.slice(-8), p.title)),
        prefix,
      ),
    handler: async (args: string, ctx: any) => {
      const needle = String(args || "").trim();
      if (!needle) {
        const list = readProposals().filter((p) => p.status === "pending" || p.status === "failed");
        const picked = await pickProposal(ctx, list, `选择要拒绝的提案（${list.length} 份）`);
        if (picked) await rejectFlow(ctx, picked);
        return;
      }
      const p = findProposal(needle);
      if (!p) {
        const hits = proposalMatches(needle);
        ctx.ui.notify(
          hits.length > 1
            ? `「${needle}」匹配到 ${hits.length} 份提案，请多输几位：${hits.map((x) => x.id.slice(-8)).join(" / ")}`
            : `找不到提案：${needle}`,
          "error",
        );
        return;
      }
      await rejectFlow(ctx, p);
    },
  });

  // 兜底：周期性清扫（例如抽取因模型忙碌失败、或快照没被任何钩子触发）。
  // 只读 inbox 目录，空闲时几乎零成本；unref 保证它不会把进程吊住。
  const sweeper = setInterval(() => void sweep(), 60_000);
  sweeper.unref?.();

  // 热路径：用户明确要求"记住这点"时，agent 可直接调用
  pi.registerTool({
    name: "memory_note",
    label: "Remember This",
    description:
      "Save one durable memory to the user's memory pool (知芽记忆池) immediately. Use it when the user explicitly asks to remember something, or when a decision/preference/lesson is clearly worth keeping. For automatic capture you do NOT need to call it — the pool captures on its own.",
    parameters: NoteParams,
    execute: async (args: any, ctx: any) => {
      const text = String(args?.text || "").trim();
      if (!text) return { content: [{ type: "text", text: "memory_note: text 为空，未记录。" }] };
      let importance = Number(args?.importance);
      let scoringFailed = false;
      if (!Number.isFinite(importance)) {
        try {
          const raw = await chat(
            `给这条要记住的信息打 1-10 分的重要性（1=琐事，10=极重）。最后一行只输出一个数字。`,
            text,
            600,
          );
          const matches = [...raw.matchAll(/\b(10|[1-9])\b/g)];
          const m = matches.length ? matches[matches.length - 1] : null;
          importance = m ? Number(m[1]) : 6;
          if (!Number.isFinite(importance)) {
            importance = 6;
            scoringFailed = true;
          }
        } catch {
          importance = 6;
          scoringFailed = true; // fail-open：打分失败也记下来，交给人工复核
        }
      }
      const items = [
        {
          text,
          type: typeof args?.type === "string" ? args.type : "semantic",
          temporal: typeof args?.temporal === "string" ? args.temporal : "retrospective",
          importance,
          // 用户明确要求记住 → 与当前任务的相关性按定义就高
          relevance: 0.9,
          project: process.env.MPI_MEMORY_PROJECT || basename(process.cwd()) || "global",
            projectRoot: process.cwd(),
          source: `note:${sessionKey(ctx)}`,
          scoringFailed,
          capturedAt: new Date().toISOString(),
        },
      ];
      const n = enqueue(items);
      log(`memory_note：入队 ${n} 条（重要性 ${importance}${scoringFailed ? "，打分失败已标记" : ""}）`);
      return {
        content: [
          {
            type: "text",
            text: n ? `已记入记忆池（重要性 ${importance}）。` : "记忆池写入失败，请查看日志。",
          },
        ],
      };
    },
  });

  // 读取：agent 主动查记忆池（语义召回走主进程端点；拿不到退字面检索）
  pi.registerTool({
    name: "memory_recall",
    label: "Recall Memory",
    description:
      "Search the user's memory pool (知芽记忆池) for durable facts, preferences, decisions and lessons from past sessions. Use it BEFORE asking the user to repeat something, or when a task may hinge on an earlier decision. Returns the best matches with type/importance/date.",
    parameters: Type.Object({
      query: Type.String({ description: "What to look for, in natural language (Chinese is fine)." }),
      topK: Type.Optional(Type.Number({ description: "How many memories to return (default 5, max 20)." })),
    }),
    execute: async (args: any, _ctx: any) => {
      const query = String(args?.query || "").trim();
      const topK = Math.max(1, Math.min(20, Number(args?.topK) || 5));
      if (!query) return { content: [{ type: "text", text: "memory_recall: query 为空。" }] };

      const remote = await remoteRecall(query, topK);
      if (remote) {
        return { content: [{ type: "text", text: formatHits(`语义检索 ${remote.kind}`, remote.hits) }] };
      }
      // 降级：读文件做字面检索（终端 pi / MPI 未运行）
      const cards = readPool(POOL_DIR);
      const local = searchPool(cards, query, topK);
      const hits = local.map((c) => ({
        id: c.id,
        score: 0.5, // 字面检索没有可比较的分数，给个中性值而不是伪造精度
        text: c.text,
        importance: c.importance,
        type: c.type,
        temporal: c.temporal,
        project: c.project,
        createdAt: c.createdAt,
      }));
      return { content: [{ type: "text", text: formatHits("字面检索（语义端点不可用）", hits) }] };
    },
  });
}
