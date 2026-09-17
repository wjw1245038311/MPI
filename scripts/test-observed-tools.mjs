import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig } = await import("../src/main/config.ts");
const {
  __resetObservedToolsForTests,
  ensureBackfilled,
  flushObservedTools,
  listObservedTools,
  recordToolCall,
} = await import("../src/main/observed-tools.ts");
const { classifyToolName } = await import("../src/shared/tool-trust-meta.ts");

// ---------------------------------------------------------------------------
// Observed tools registry (trusted-tools picker data source)
// ---------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), "mpi-observed-tools-"));
const sessionsDir = join(dataDir, "sessions");
mkdirSync(sessionsDir, { recursive: true });

function toolResultLine(name) {
  return (
    `{"type":"message","id":"x1","parentId":"p","timestamp":"2026-09-17T00:00:00.000Z",` +
    `"message":{"role":"toolResult","toolCallId":"TC1","toolName":"${name}","content":[{"type":"text","text":"ok"}]}}`
  );
}

try {
  // Point the store at a throwaway userData dir whose config pins a custom
  // sessions root (so backfill never touches the real ~/.pi/agent/sessions).
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ sessionStorageDir: sessionsDir }), "utf8");
  loadConfig(dataDir);

  // --- live recording -------------------------------------------------------
  assert.deepEqual(listObservedTools(), [], "starts empty");

  recordToolCall("mem0_memory");
  recordToolCall("mcp");
  recordToolCall("mem0_memory"); // count increments, no duplicate entry
  const list = listObservedTools();
  assert.deepEqual(
    list.map((t) => t.name),
    ["mcp", "mem0_memory"],
    "sorted by name",
  );
  const mem0 = list.find((t) => t.name === "mem0_memory");
  assert.equal(mem0.count, 2);
  assert.ok(typeof mem0.firstSeen === "number" && typeof mem0.lastSeen === "number");

  // empty / non-string names are ignored
  recordToolCall("");
  recordToolCall("   ");
  recordToolCall(42);
  assert.equal(listObservedTools().length, 2);

  // persistence: flush then read the raw JSON back
  flushObservedTools();
  const onDisk = JSON.parse(readFileSync(join(dataDir, "observed-tools.json"), "utf8"));
  assert.equal(onDisk.mem0_memory.count, 2);

  // --- one-time backfill from historical session files ----------------------
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    [toolResultLine("bash"), toolResultLine("read"), toolResultLine("mem0_memory")].join("\n") + "\n",
    "utf8",
  );
  // Noise that must NOT match: a bare "toolName" inside quoted output text, and
  // an assistant message (different shape).
  writeFileSync(
    join(sessionsDir, "b.jsonl"),
    [
      `{"type":"message","id":"n1","parentId":"p","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"the log said \\"toolName\\":\\"evil_fake\\" twice"}]}}`,
      toolResultLine("mcp"), // merges with the live entry above
    ].join("\n") + "\n",
    "utf8",
  );

  await ensureBackfilled();
  const after = Object.fromEntries(listObservedTools().map((t) => [t.name, t]));
  assert.ok(after.bash && after.read, "backfill adds historical names");
  assert.equal(after.mem0_memory.count, 3, "live count + backfill occurrence merge");
  assert.equal(after.mcp.count, 2);
  assert.ok(!after.evil_fake, "quoted toolName inside user text is not a false positive");
  // Backfilled-only entries have null timestamps (no live observation).
  assert.equal(after.bash.firstSeen, null);

  // ensureBackfilled latches: second call returns the same promise, no re-scan.
  const p1 = ensureBackfilled();
  const p2 = ensureBackfilled();
  assert.equal(p1, p2);
  await p1;

  // --- cap / pruning ---------------------------------------------------------
  __resetObservedToolsForTests();
  loadConfig(dataDir); // re-point after reset (cache cleared)
  for (let i = 0; i < 505; i++) recordToolCall(`tool_${String(i).padStart(3, "0")}`);
  flushObservedTools();
  const capped = listObservedTools();
  assert.ok(capped.length <= 500, `cap enforced (${capped.length})`);

  // --- classification (shared with the picker UI) ----------------------------
  assert.equal(classifyToolName("mem0_memory", ["mem0_memory"]), "trusted");
  assert.equal(classifyToolName("mcp", []), "trustable");
  assert.equal(classifyToolName("bash", []), "never-trustable");
  assert.equal(classifyToolName("write", ["write"]), "trusted", "trusted wins so bad entries stay removable");
  assert.equal(classifyToolName("web_search", []), "no-approval");
  assert.equal(classifyToolName("read", []), "no-approval");

  console.log("observed-tools: all tests passed");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
