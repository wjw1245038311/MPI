import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const agentDir = mkdtempSync(join(tmpdir(), "mpi-usage-"));
process.env.PI_AGENT_DIR = agentDir; // getSessionsDir() reads this at call time

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

const u = await getTotalUsage();
assert.equal(u.sessions, 2, "scans every session file");
assert.equal(u.tokens, 100 + 200 + 50 + 30, "all-time tokens sum across files");
assert.equal(u.cost, 0.75, "all-time cost sums (missing cost fields ignored)");
assert.equal(u.todayTokens, 100 + 30, "today = only entries timestamped local-today");
assert.equal(u.todayCost, 0.5, "today cost follows the same timestamp filter");

// missing sessions dir → all zeros including today fields
process.env.PI_AGENT_DIR = join(agentDir, "nope");
const empty = await getTotalUsage();
assert.deepEqual(empty, { tokens: 0, cost: 0, sessions: 0, todayTokens: 0, todayCost: 0 });

rmSync(agentDir, { recursive: true, force: true });
console.log("usage tests passed");
