import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const {
  WEB_SEARCH_AUTO_WORKFLOW,
  WEB_SEARCH_SUMMARY_DEADLINE_MS,
  autoAnswerModelSelect,
  createWebSearchFlow,
  isLikelyModelSelect,
  webSearchConfigPath,
} = await import("../src/main/web-search-config.ts");

const root = mkdtempSync(join(tmpdir(), "mpi-websearch-"));
let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

/** Fresh sandbox: configDir for the sidecar + agent dir for web-search.json. */
function sandbox() {
  const base = mkdtempSync(join(root, "case-"));
  const configDir = join(base, "config");
  const agentDir = join(base, "agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const env = { PI_CODING_AGENT_DIR: agentDir };
  return { base, configDir, agentDir, env, file: join(agentDir, "web-search.json") };
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/* ---------------- webSearchConfigPath ---------------- */
{
  const s = sandbox();
  assert.equal(webSearchConfigPath(s.env), s.file);
  ok("PI_CODING_AGENT_DIR wins");

  // XDG_CONFIG_HOME/pi is used when it already holds the file…
  const xdgBase = mkdtempSync(join(root, "xdg-"));
  const xdgPi = join(xdgBase, "pi");
  mkdirSync(xdgPi, { recursive: true });
  writeFileSync(join(xdgPi, "web-search.json"), "{}");
  assert.equal(webSearchConfigPath({ XDG_CONFIG_HOME: xdgBase }), join(xdgPi, "web-search.json"));

  // …and when nothing exists anywhere. The legacy ~/.pi check goes through
  // os.homedir(), which reads USERPROFILE/HOME from process.env — swap it.
  const home = mkdtempSync(join(root, "home-"));
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    // No file anywhere → the (empty) XDG dir is created as target.
    assert.equal(webSearchConfigPath({ XDG_CONFIG_HOME: join(home, "nope") }), join(home, "nope", "pi", "web-search.json"));

    // Legacy ~/.pi/web-search.json wins over the (empty) XDG dir.
    const legacyHome = mkdtempSync(join(root, "home2-"));
    process.env.HOME = legacyHome;
    process.env.USERPROFILE = legacyHome;
    mkdirSync(join(legacyHome, ".pi"), { recursive: true });
    writeFileSync(join(legacyHome, ".pi", "web-search.json"), "{}");
    assert.equal(
      webSearchConfigPath({ XDG_CONFIG_HOME: join(legacyHome, "xdg") }),
      join(legacyHome, ".pi", "web-search.json"),
    );

    // No XDG at all → ~/.pi.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.equal(webSearchConfigPath({}), join(home, ".pi", "web-search.json"));
  } finally {
    for (const [key, value] of Object.entries(savedHome)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  ok("XDG / legacy / default resolution");
}

/* ---------------- sync(): create + preserve + dedupe ---------------- */
{
  const s = sandbox();
  const flow = createWebSearchFlow(s.configDir, s.env);

  assert.equal(existsSync(s.file), false);
  assert.equal(flow.sync({ provider: "bailian-api", id: "qwen3-max" }), true);
  let doc = readJson(s.file);
  assert.equal(doc.workflow, WEB_SEARCH_AUTO_WORKFLOW);
  assert.equal(doc.summaryModel, "bailian-api/qwen3-max");
  assert.equal(doc.summaryGenerationDeadlineMs, WEB_SEARCH_SUMMARY_DEADLINE_MS);
  const sidecar = join(s.configDir, "web-search-orig.json");
  assert.deepEqual(readJson(sidecar), { fileExisted: false, workflow: null, summaryModel: null, summaryGenerationDeadlineMs: null });
  ok("creates file + all-null sidecar on first touch");

  // Same model again → no rewrite (content identical).
  const before = readFileSync(s.file, "utf8");
  assert.equal(flow.sync({ provider: "bailian-api", id: "qwen3-max" }), true);
  assert.equal(readFileSync(s.file, "utf8"), before);
  ok("dedupes unchanged syncs");

  // Model switch → only summaryModel changes.
  assert.equal(flow.sync({ provider: "new-provider", id: "qwen3.8-27b@q5_k_m" }), true);
  doc = readJson(s.file);
  assert.equal(doc.summaryModel, "new-provider/qwen3.8-27b@q5_k_m");
  ok("model switch updates summaryModel (quantized @ ids survive)");

  // A user edit between syncs (e.g. an API key) must be preserved on the next write.
  doc.anysearchApiKey = "sk-user-key";
  writeFileSync(s.file, JSON.stringify(doc, null, 2));
  assert.equal(flow.sync({ provider: "new-provider", id: "qwen3.8-27b@q5_k_m" }), true);
  doc = readJson(s.file);
  assert.equal(doc.anysearchApiKey, "sk-user-key");
  ok("preserves foreign keys across syncs");

  // sync(null) keeps the workflow but leaves summaryModel alone.
  assert.equal(flow.sync(null), true);
  doc = readJson(s.file);
  assert.equal(doc.workflow, WEB_SEARCH_AUTO_WORKFLOW);
  assert.equal(doc.summaryModel, "new-provider/qwen3.8-27b@q5_k_m");
  ok("sync(null) applies workflow without touching summaryModel");
}

/* ---------------- sync(): preserves pre-existing managed values + restore ---------------- */
{
  const s = sandbox();
  writeFileSync(
    s.file,
    JSON.stringify({ provider: "brave", anysearchApiKey: "sk-123", workflow: "summary-review", summaryModel: "openai/gpt-5-mini" }),
  );
  const flow = createWebSearchFlow(s.configDir, s.env);
  assert.equal(flow.sync({ provider: "p", id: "m" }), true);

  let doc = readJson(s.file);
  assert.equal(doc.workflow, WEB_SEARCH_AUTO_WORKFLOW);
  assert.equal(doc.summaryModel, "p/m");
  assert.equal(doc.provider, "brave");
  assert.equal(doc.anysearchApiKey, "sk-123");
  const sidecar = join(s.configDir, "web-search-orig.json");
  assert.deepEqual(readJson(sidecar), { fileExisted: true, workflow: "summary-review", summaryModel: "openai/gpt-5-mini", summaryGenerationDeadlineMs: null });
  ok("backs up original managed values on first touch");

  // Second sync must NOT re-back-up (sidecar keeps the true originals).
  doc.workflow = "auto-summary";
  writeFileSync(s.file, JSON.stringify(doc));
  flow.sync({ provider: "p2", id: "m2" });
  assert.deepEqual(readJson(sidecar), { fileExisted: true, workflow: "summary-review", summaryModel: "openai/gpt-5-mini", summaryGenerationDeadlineMs: null });

  // Restore → exact pre-MPI state (deadline key removed, others intact).
  assert.equal(flow.restore(), true);
  doc = readJson(s.file);
  assert.deepEqual(doc, { provider: "brave", anysearchApiKey: "sk-123", workflow: "summary-review", summaryModel: "openai/gpt-5-mini" });
  assert.equal(existsSync(sidecar), false);
  ok("restore() returns the exact pre-MPI file and drops the sidecar");

  // Restore without a sidecar is a clean no-op.
  assert.equal(flow.restore(), true);
  assert.deepEqual(readJson(s.file), doc);
  ok("restore() no-ops when MPI never touched the file");
}

/* ---------------- restore(): deletes a file MPI created from scratch ---------------- */
{
  const s = sandbox();
  const flow = createWebSearchFlow(s.configDir, s.env);
  assert.equal(flow.sync({ provider: "p", id: "m" }), true);
  assert.equal(existsSync(s.file), true);

  // Nothing else in the file → exact restore deletes it again.
  assert.equal(flow.restore(), true);
  assert.equal(existsSync(s.file), false);
  ok("restore() removes a file MPI created when nothing else is in it");

  // …but keeps keys the user added meanwhile.
  flow.sync({ provider: "p", id: "m" });
  const doc = readJson(s.file);
  doc.tavilyApiKey = "tvly-user";
  writeFileSync(s.file, JSON.stringify(doc));
  assert.equal(flow.restore(), true);
  assert.deepEqual(readJson(s.file), { tavilyApiKey: "tvly-user" });
  ok("restore() keeps user-added keys in a file MPI created");
}

/* ---------------- corruption guard ---------------- */
{
  const s = sandbox();
  writeFileSync(s.file, "{ this is not json");
  const flow = createWebSearchFlow(s.configDir, s.env);
  assert.equal(flow.sync({ provider: "p", id: "m" }), false);
  assert.equal(readFileSync(s.file, "utf8"), "{ this is not json");
  ok("corrupt file is never overwritten by sync()");

  writeFileSync(join(s.configDir, "web-search-orig.json"), JSON.stringify({ workflow: null, summaryModel: null, summaryGenerationDeadlineMs: null }));
  assert.equal(flow.restore(), false);
  assert.equal(readFileSync(s.file, "utf8"), "{ this is not json");
  ok("corrupt file is never overwritten by restore()");
}

/* ---------------- isLikelyModelSelect heuristic ---------------- */
{
  assert.equal(isLikelyModelSelect({ method: "select", options: ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"] }), true);
  assert.equal(isLikelyModelSelect({ method: "select", options: ["new-provider/qwen3.8-27b@q5_k_m", "x/y"] }), true);
  ok("accepts provider/model option lists");

  // pi-web-access "Stored Search Results" style options must NOT match.
  assert.equal(
    isLikelyModelSelect({
      method: "select",
      options: ['[abc123] "weather in tokyo" (2 queries) - 5m ago', "[def456] 3 URLs fetched - 1h ago"],
    }),
    false,
  );
  assert.equal(isLikelyModelSelect({ method: "select", options: ["View details", "Delete"] }), false);
  assert.equal(isLikelyModelSelect({ method: "select", options: ["only-one/model"] }), false);
  assert.equal(isLikelyModelSelect({ method: "confirm", options: ["a/b", "c/d"] }), false);
  assert.equal(isLikelyModelSelect({ method: "select", options: ["a/b", "Use gpt-5 (fast)"] }), false);
  assert.equal(isLikelyModelSelect(null), false);
  ok("rejects non-model selects");
}

/* ---------------- autoAnswerModelSelect ---------------- */
{
  const calls = [];
  const bridge = {
    getState: async () => ({ model: { provider: "bailian-api", id: "qwen3-max" } }),
    respondExtUi: (id, payload) => calls.push({ id, ...payload }),
  };

  assert.equal(
    await autoAnswerModelSelect(bridge, { id: "r1", method: "select", options: ["other/model", "bailian-api/qwen3-max"] }),
    true,
  );
  assert.deepEqual(calls, [{ id: "r1", value: "bailian-api/qwen3-max" }]);
  ok("answers with the thread's current model when listed");

  calls.length = 0;
  assert.equal(
    await autoAnswerModelSelect(bridge, { id: "r2", method: "select", options: ["other/model", "x/y"] }),
    false,
  );
  assert.deepEqual(calls, []);
  ok("falls through when the current model is not an option");

  calls.length = 0;
  assert.equal(
    await autoAnswerModelSelect(bridge, { id: "r3", method: "select", options: ['[abc123] "q" - 5m ago', "[def456] x"] }),
    false,
  );
  assert.deepEqual(calls, []);
  ok("ignores non-model selects");

  // Broken bridge → never throws.
  const broken = { getState: async () => { throw new Error("exited"); }, respondExtUi: () => {} };
  assert.equal(
    await autoAnswerModelSelect(broken, { id: "r4", method: "select", options: ["a/b", "c/d"] }),
    false,
  );
  ok("never throws on bridge errors");
}

rmSync(root, { recursive: true, force: true });
console.log(`\nweb-search-config: ${passed} groups passed`);
