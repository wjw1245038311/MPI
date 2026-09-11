import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const agentDir = mkdtempSync(join(tmpdir(), "mpi-usage-"));
process.env.PI_AGENT_DIR = agentDir; // getSessionsDir() reads this at call time

// getSessionsDir() consults config (custom data-storage dir) — load a throwaway one.
const { loadConfig } = await import("../src/main/config.ts");
loadConfig(mkdtempSync(join(tmpdir(), "mpi-usage-cfg-")));

const { getTotalUsage } = await import("../src/main/session-store.ts");

const projDir = join(agentDir, "sessions", "proj-a");
mkdirSync(projDir, { recursive: true });

const now = new Date();
const today = now.toISOString();
const yesterday = new Date(now.getTime() - 86_400_000).toISOString();

writeFileSync(
  join(projDir, "a.jsonl"),
  [
    JSON.stringify({ type: "session", id: "s1", cwd: "/tmp/proj-a", timestamp: today }),
    // local-today message with tokens + cost → counts toward both totals
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 100, cost: { total: 0.5 } } }, timestamp: today }),
    // yesterday's message → all-time only
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 200 } }, timestamp: yesterday }),
    // no parseable timestamp → all-time only (never "today")
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 50, cost: { total: 0.25 } } } }),
    JSON.stringify({ type: "session_info", name: "test" }),
  ].join("\n") + "\n",
);

// second file to check aggregation across files
writeFileSync(
  join(projDir, "b.jsonl"),
  [JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 30 } }, timestamp: today })].join("\n") + "\n",
);
// Pin b's mtime to a whole second so the cache-hit test below can restore it
// exactly — sub-ms FILETIME precision does not survive float64 round-trips.
const bFixedTime = Math.floor(Date.now() / 1000);
utimesSync(join(projDir, "b.jsonl"), bFixedTime, bFixedTime);

const u = await getTotalUsage();
assert.equal(u.sessions, 2, "scans every session file");
assert.equal(u.tokens, 100 + 200 + 50 + 30, "all-time tokens sum across files");
assert.equal(u.cost, 0.75, "all-time cost sums (missing cost fields ignored)");
assert.equal(u.todayTokens, 100 + 30, "today = only entries timestamped local-today");
assert.equal(u.todayCost, 0.5, "today cost follows the same timestamp filter");

// --- mtime+size cache behavior -------------------------------------------------
const aFile = join(projDir, "a.jsonl");
const bFile = join(projDir, "b.jsonl");

// Cache hit: corrupt b.jsonl in place with the SAME byte length and restore its
// mtime. If getTotalUsage re-read it, every line would fail JSON.parse and b's
// 30 tokens would vanish from the totals — identical results prove the cache served it.
const stB = statSync(bFile);
writeFileSync(bFile, "x".repeat(stB.size));
utimesSync(bFile, bFixedTime, bFixedTime); // restore the pinned whole-second mtime
const u2 = await getTotalUsage();
assert.deepEqual(u2, u, "unchanged (mtime,size) files are served from cache — content never re-read");

// Cache miss: appending to a.jsonl changes its mtime+size → only a is re-parsed.
// b stays cached (its corrupted content must NOT be read), so totals gain exactly the append.
appendFileSync(aFile, JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 70, cost: { total: 0.35 } } }, timestamp: today }) + "\n");
const u3 = await getTotalUsage();
assert.equal(u3.sessions, 2);
assert.equal(u3.tokens, 450, "changed file re-parsed (380+70), cached file untouched despite corruption");
assert.equal(u3.cost, 1.1, "cost follows the same split (0.75+0.35)");
assert.equal(u3.todayTokens, 200, "today bucket: 130 + appended 70");
assert.equal(u3.todayCost, 0.85);

// Pruning: deleting b.jsonl drops it from the totals and the cache.
unlinkSync(bFile);
const u4 = await getTotalUsage();
assert.deepEqual(u4, { tokens: 420, cost: 1.1, sessions: 1, todayTokens: 170, todayCost: 0.85 }, "deleted file pruned from totals and cache");

// missing sessions dir → all zeros including today fields
process.env.PI_AGENT_DIR = join(agentDir, "nope");
const empty = await getTotalUsage();
assert.deepEqual(empty, { tokens: 0, cost: 0, sessions: 0, todayTokens: 0, todayCost: 0 });

rmSync(agentDir, { recursive: true, force: true });
console.log("usage tests passed");
