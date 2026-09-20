/**
 * 抽取质量诊断（P1）：把一段**真实会话**喂给扩展用的同一套提示词，看它抽出什么。
 * 提示词直接从 mpi-memory-ext.ts 源码里抠出来（避免两处漂移）；分段参数与扩展一致。
 * 运行：npm run diag:extract [session.jsonl] [窗口条数]
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SRC = "src/main/mpi-memory-ext.ts";
const src = readFileSync(SRC, "utf8");
const sysMatch = /const EXTRACT_SYSTEM = `([\s\S]*?)`;/.exec(src);
if (!sysMatch) {
  console.error("没能从扩展源码里抠出 EXTRACT_SYSTEM 提示词");
  process.exit(1);
}
const SYSTEM = sysMatch[1];
const CHUNK = Number(process.env.MPI_MEMORY_CHUNK_CHARS || 3000);
const LLM_URL = process.env.MPI_MEMORY_LLM_URL || "http://127.0.0.1:1234/v1/chat/completions";
const LLM_MODEL = process.env.MPI_MEMORY_LLM_MODEL || "qwen3.8-27b@q5_k_m";

const SEP = `${String.fromCharCode(10)}${String.fromCharCode(10)}`; // 空行

function newestSession() {
  const root = join(homedir(), ".pi", "agent", "sessions");
  let best = null;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        const m = statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    }
  };
  walk(root);
  return best?.p;
}

function windowOf(p, n) {
  const turns = [];
  for (const line of readFileSync(p, "utf8").split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "message") continue;
    const m = d.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const t =
      typeof m.content === "string"
        ? m.content
        : (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join(String.fromCharCode(10));
    if (!t || !t.trim()) continue;
    turns.push(`【${m.role === "user" ? "用户" : "助手"}】${t.trim().slice(0, 1200)}`);
  }
  return turns.slice(-n).join(SEP);
}

function chunk(w, max = CHUNK) {
  if (w.length <= max) return [w];
  const parts = [];
  let cur = "";
  for (const block of w.split(SEP)) {
    if (cur && cur.length + block.length + 2 > max) {
      parts.push(cur);
      cur = block;
    } else {
      cur = cur ? cur + SEP + block : block;
    }
  }
  if (cur) parts.push(cur);
  return parts.slice(-3);
}

function parseLoose(raw) {
  const body = raw.replace(/```json/gi, "```");
  const fence = /```([\s\S]*?)```/.exec(body);
  const s = fence ? fence[1] : body;
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

async function runChunk(text) {
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `对话片段：${SEP}${text}` },
      ],
      temperature: 0,
      max_tokens: 6000,
      stream: false,
    }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const ch = j.choices?.[0];
  // 本机是推理模型：思考在 reasoning_content、答案在 content；content 空时兜 reasoning
  const content = (ch?.message?.content || "").trim();
  const raw = content || (ch?.message?.reasoning_content || "").trim();
  const meta = `finish=${ch?.finish_reason} completion=${j.usage?.completion_tokens}（reasoning ${j.usage?.completion_tokens_details?.reasoning_tokens ?? "?"}）`;
  const obj = parseLoose(raw);
  const mems = Array.isArray(obj?.memories) ? obj.memories : [];
  console.log(`  段（${text.length} 字）：${meta} → ${mems.length} 条${!content && mems.length ? "（答案从 reasoning 兜出）" : ""}${!mems.length && !content ? "  ⚠️ content 为空（token 被思考吃光）" : ""}`);
  return mems;
}

const WRITE = process.argv.includes("--write");
const INBOX_ENV = process.env.MPI_MEMORY_INBOX_DIR || "";

/** 把候选写进 inbox（与扩展写出的形状一致），交给主进程落池。 */
function enqueueToInbox(items) {
  if (!WRITE || !INBOX_ENV) return 0;
  mkdirSync(INBOX_ENV, { recursive: true });
  let n = 0;
  for (const [i, it] of items.entries()) {
    const name = `${Date.now()}-backfill-${i}-${Math.random().toString(36).slice(2, 8)}.json`;
    writeFileSync(join(INBOX_ENV, name), JSON.stringify(it, null, 1), "utf8");
    n++;
  }
  return n;
}

const file = process.argv[2] || newestSession();
const N = Number(process.argv[3] || 14);
let win;
let pendingItems = null;
try {
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed) && parsed.every((x) => x && typeof x === "object" && typeof x.window === "string")) {
    pendingItems = parsed;
  }
} catch {
  /* 不是 JSON → 当会话文件 */
}
win = pendingItems ? pendingItems.map((x) => x.window).join(SEP) : windowOf(file, N);
console.log(`会话文件：${file}`);
console.log(`窗口：最近 ${N} 轮，${win.length} 字符${SEP}`);

const chunks = chunk(win);
console.log(`切分 ${chunks.length} 段：${chunks.map((c) => c.length).join(" / ")} 字符${SEP}`);

const t0 = Date.now();
const all = [];
for (const c of chunks) {
  try {
    all.push(...(await runChunk(c)));
  } catch (e) {
    console.log(`  段失败：${e.message}`);
  }
}
console.log(`${String.fromCharCode(10)}模型 ${LLM_MODEL}　总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${SEP}`);

const uniq = new Map();
for (const m of all) {
  if (!m || typeof m.text !== "string") continue;
  const key = m.text.replace(/\s+/g, "");
  const prev = uniq.get(key);
  if (!prev || Number(m.importance) > Number(prev.importance)) uniq.set(key, m);
}
const mems = [...uniq.values()].sort((a, b) => Number(b.importance) - Number(a.importance));
console.log(`抽出 ${mems.length} 条（去重后；扩展只把 importance ≥4 的入队）：${SEP}`);
for (const m of mems) {
  const imp = Number(m.importance);
  const mark = imp >= 7 ? "🔴" : imp >= 4 ? "🟡" : "⚪";
  console.log(`${mark} [${imp}] (${m.type}/${m.temporal}) ${m.text}`);
  if (m.reason) console.log(`       理由：${m.reason}`);
}
if (WRITE) {
  const items = mems
    .filter((m) => Number(m.importance) >= 4)
    .map((m) => ({
      text: m.text,
      type: m.type,
      temporal: m.temporal,
      importance: Number(m.importance),
      relevance: 0.7,
      project: process.env.MPI_MEMORY_PROJECT || "backfill",
      source: `backfill:${Date.now()}`,
      reason: m.reason,
      capturedAt: new Date().toISOString(),
    }));
  const wrote = enqueueToInbox(items);
  console.log(`已写入 inbox ${wrote} 条 → ${INBOX_ENV || "(未设置 MPI_MEMORY_INBOX_DIR)"}`);
}

const ge7 = mems.filter((m) => m.importance >= 7).length;
const mid = mems.filter((m) => m.importance >= 4 && m.importance < 7).length;
const low = mems.filter((m) => m.importance < 4).length;
console.log(`${String.fromCharCode(10)}统计：≥7 分 ${ge7} 条｜4-6 分 ${mid} 条｜<4 分（会被丢）${low} 条`);
