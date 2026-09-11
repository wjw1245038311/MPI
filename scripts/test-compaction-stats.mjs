import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

// Point the session store at a throwaway agent dir (getAgentDir reads env lazily).
const agentDir = mkdtempSync(join(tmpdir(), "mpi-comps-"));
process.env.PI_AGENT_DIR = agentDir;

// getSessionsDir() consults config (custom data-storage dir) — load a throwaway one.
const { loadConfig } = await import("../src/main/config.ts");
loadConfig(mkdtempSync(join(tmpdir(), "mpi-comps-cfg-")));

const { readSessionCompactions } = await import("../src/main/session-store.ts");

const sessionsDir = join(agentDir, "sessions", "--C--proj--");
mkdirSync(sessionsDir, { recursive: true });

// --- counts compaction entries, keeps the latest timestamp -----------------
const file = join(sessionsDir, "test.jsonl");
writeFileSync(
  file,
  [
    JSON.stringify({ type: "message", id: "a" }),
    JSON.stringify({ type: "compaction", id: "c1", parentId: "a", timestamp: "2026-09-08T03:01:37.500Z", summary: "s1" }),
    JSON.stringify({ type: "message", id: "b" }),
    // A branch_summary is NOT a compaction and must not be counted.
    JSON.stringify({ type: "branch_summary", id: "bs1", timestamp: "2026-09-08T03:30:00.000Z" }),
    JSON.stringify({ type: "compaction", id: "c2", parentId: "b", timestamp: "2026-09-08T04:00:00.000Z", summary: "s2" }),
  ].join("\n") + "\n",
);

const stats = await readSessionCompactions(file);
assert.deepEqual(stats, { count: 2, lastAt: "2026-09-08T04:00:00.000Z" });

// --- zero compactions -------------------------------------------------------
const emptyFile = join(sessionsDir, "empty.jsonl");
writeFileSync(emptyFile, JSON.stringify({ type: "message", id: "x" }) + "\n");
assert.deepEqual(await readSessionCompactions(emptyFile), { count: 0, lastAt: null });

// --- safety: paths outside the sessions dir are refused ---------------------
const outside = join(agentDir, "outside.jsonl");
writeFileSync(outside, JSON.stringify({ type: "compaction", id: "x" }) + "\n");
assert.equal(await readSessionCompactions(outside), null);

// --- missing file -> null ----------------------------------------------------
assert.equal(await readSessionCompactions(join(sessionsDir, "nope.jsonl")), null);

console.log("test-compaction-stats: all assertions passed");
