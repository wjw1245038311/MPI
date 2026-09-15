/** Automation task model selection (T1) — resolveTaskModel + config persistence:
 * tasks may pin an explicit provider/modelId pair; a lone half is dropped at load. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig, resolveTaskModel } = await import("../src/main/config.ts");

let passed = 0;
function ok(name) {
  passed++;
  console.log(`PASS ${name}`);
}

// --- resolveTaskModel ---------------------------------------------------------
assert.deepEqual(resolveTaskModel({ provider: "openai", modelId: "gpt-5" }), { provider: "openai", modelId: "gpt-5" });
assert.equal(resolveTaskModel({}), null, "no fields -> default");
assert.equal(resolveTaskModel({ provider: "", modelId: "" }), null);
assert.equal(resolveTaskModel({ provider: "  ", modelId: " gpt-5 " }), null, "blank provider -> default");
assert.equal(resolveTaskModel({ provider: "openai" }), null, "lone provider -> default");
assert.equal(resolveTaskModel({ modelId: "gpt-5" }), null, "lone modelId -> default");
assert.equal(resolveTaskModel({ provider: 42, modelId: "gpt-5" }), null, "non-string provider -> default");
ok("resolveTaskModel accepts only complete string pairs");

// --- config persistence -------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "mpi-auto-model-"));
try {
  const taskBase = { id: "t1", name: "n", cwd: "/tmp", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, enabled: true, permission: "sandbox" };

  // A complete pair survives the round trip (trimmed).
  writeFileSync(join(dir, "config.json"), JSON.stringify({ automationTasks: [{ ...taskBase, provider: " openai ", modelId: " gpt-5 " }] }));
  let cfg = loadConfig(dir);
  assert.deepEqual(cfg.automationTasks[0].provider, "openai");
  assert.deepEqual(cfg.automationTasks[0].modelId, "gpt-5");
  ok("complete provider/modelId pair persists (trimmed)");

  // A lone half is dropped at load time.
  writeFileSync(join(dir, "config.json"), JSON.stringify({ automationTasks: [{ ...taskBase, provider: "openai" }] }));
  cfg = loadConfig(dir);
  assert.equal(cfg.automationTasks[0].provider, undefined);
  assert.equal(cfg.automationTasks[0].modelId, undefined);
  ok("lone half is dropped at load");

  // Legacy tasks without the fields keep working (undefined -> default model).
  writeFileSync(join(dir, "config.json"), JSON.stringify({ automationTasks: [taskBase] }));
  cfg = loadConfig(dir);
  assert.equal(resolveTaskModel(cfg.automationTasks[0]), null);
  ok("legacy tasks without model fields resolve to pi default");

  console.log(`\n${passed} groups passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
