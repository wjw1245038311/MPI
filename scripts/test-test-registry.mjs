import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const { listRegistryCases, parseRegistryCase, REGISTRY_DIR_REL } = await import("../src/main/test-registry.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ? ${label}`);
};

const validLogic = {
  id: "logic-demo",
  title: "示例逻辑用例",
  feature: "示例功能",
  kind: "logic",
  source: "changelog#1",
  logicTest: "trustedtools",
  passCriteria: "npm test 全绿",
};
const validScenario = {
  id: "scenario-demo",
  title: "示例场景用例",
  feature: "示例功能",
  kind: "scenario",
  source: "changelog#2",
  harnessCaseId: "c1-enforcement",
  assertions: ["write/edit 被拒", "零文件变更"],
  passCriteria: "checks.writeHidden",
  repeat: 2,
};

// --- valid cases pass and normalize optional fields -------------------------
{
  const a = parseRegistryCase(validLogic);
  assert.equal(a.ok, true);
  if (a.ok) {
    assert.equal(a.value.logicTest, "trustedtools");
    assert.equal(a.value.harnessCaseId, undefined, "logic case drops scenario fields");
    assert.equal(a.value.repeat, undefined);
  }
  const b = parseRegistryCase(validScenario);
  assert.equal(b.ok, true);
  if (b.ok) {
    assert.deepEqual(b.value.assertions, ["write/edit 被拒", "零文件变更"]);
    assert.equal(b.value.repeat, 2);
    assert.equal(b.value.logicTest, undefined);
  }
  ok("valid logic/scenario cases parse and drop absent optionals");
}

// --- malformed cases are rejected with reasons ------------------------------
{
  assert.equal(parseRegistryCase(null).ok, false);
  assert.equal(parseRegistryCase([]).ok, false);
  assert.equal(parseRegistryCase("x").ok, false);

  const bad = [
    [{ ...validLogic, id: "Bad Id" }, /id 不合法/],
    [{ ...validLogic, id: "" }, /id 必须/],
    [{ ...validLogic, title: "  " }, /title/],
    [{ ...validLogic, feature: undefined }, /feature/],
    [{ ...validLogic, source: undefined }, /source/],
    [{ ...validLogic, passCriteria: undefined }, /passCriteria/],
    [{ ...validLogic, kind: "unit" }, /kind/],
    [{ ...validLogic, logicTest: undefined }, /logicTest/],
    [{ ...validScenario, harnessCaseId: undefined }, /harnessCaseId/],
  ];
  for (const [raw, re] of bad) {
    const r = parseRegistryCase(raw);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(raw)}`);
    if (!r.ok) assert.ok(r.errors.some((e) => re.test(e)), `reason matches ${re}: ${r.errors.join("; ")}`);
  }
  ok("missing/invalid required fields are rejected with reasons");
}

// --- assertions / repeat shape ---------------------------------------------
{
  assert.equal(parseRegistryCase({ ...validLogic, assertions: "not-array" }).ok, false);
  assert.equal(parseRegistryCase({ ...validLogic, assertions: [] }).ok, false);
  assert.equal(parseRegistryCase({ ...validLogic, assertions: ["ok", ""] }).ok, false);
  assert.equal(parseRegistryCase({ ...validLogic, repeat: 0 }).ok, false);
  assert.equal(parseRegistryCase({ ...validLogic, repeat: 1.5 }).ok, false);
  assert.equal(parseRegistryCase({ ...validLogic, repeat: "2" }).ok, false);
  assert.equal(parseRegistryCase({ ...validLogic, repeat: 3 }).ok, true);
  assert.equal(parseRegistryCase({ ...validLogic, description: "  " }).ok, false);
  ok("assertions/repeat/description shapes are validated");
}

// --- scanning the real repo registry ---------------------------------------
{
  const scan = listRegistryCases(ROOT);
  assert.deepEqual(scan.errors, [], `registry scan errors: ${JSON.stringify(scan.errors)}`);
  const ids = scan.cases.map((c) => c.id);
  assert.ok(ids.includes("logic-trusted-tools"), `missing logic seed: ${ids.join(", ")}`);
  assert.ok(ids.includes("scenario-mode-switch-loop"), `missing scenario seed: ${ids.join(", ")}`);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  const sorted = [...scan.cases].sort((a, b) => a.feature.localeCompare(b.feature) || a.id.localeCompare(b.id));
  assert.deepEqual(ids, sorted.map((c) => c.id), "cases sorted by feature then id");
  ok(`repo registry scans clean (${scan.cases.length} cases, dir=${REGISTRY_DIR_REL})`);
}

// --- missing directory is empty, not an error ------------------------------
{
  const scan = listRegistryCases(join(ROOT, "tests", "__no_such_dir__"));
  assert.deepEqual(scan, { cases: [], errors: [] });
  ok("missing registry dir yields empty scan");
}

console.log(`\ntest-registry: ${passed} groups passed`);
