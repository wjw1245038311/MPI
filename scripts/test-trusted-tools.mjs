import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const {
  COMMON_EXTENSION_TOOLS,
  NEVER_TRUSTABLE_TOOLS,
  isTrustableToolName,
  isTrustedTool,
  toggleTrustedTool,
} = await import("../src/renderer/src/lib/trusted-tools.ts");

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

// --- presets are well-formed and shared with the gate's rules ---------------
{
  assert.ok(COMMON_EXTENSION_TOOLS.length >= 1, "at least one preset");
  const names = COMMON_EXTENSION_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "preset names are unique");
  for (const tool of COMMON_EXTENSION_TOOLS) {
    assert.ok(tool.name.trim().length > 0, "non-empty name");
    assert.ok(isTrustableToolName(tool.name), `${tool.name} is trustable`);
    assert.ok(tool.zh.trim().length > 0 && tool.en.trim().length > 0, `${tool.name} has bilingual copy`);
  }
  assert.ok(names.includes("mem0_memory"), "mem0_memory ships as a preset");
  ok("presets are unique, trustable and bilingual");
}

// --- never-trustable floor -------------------------------------------------
{
  assert.deepEqual([...NEVER_TRUSTABLE_TOOLS].sort(), ["bash", "edit", "write"]);
  for (const name of ["bash", "write", "edit", " bash ", "edit "]) {
    assert.equal(isTrustableToolName(name), false, `${name} is not trustable`);
  }
  assert.equal(isTrustableToolName(""), false);
  assert.equal(isTrustableToolName("   "), false);
  assert.equal(isTrustableToolName("mem0_memory"), true);
  ok("bash/write/edit and blank names are rejected");
}

// --- toggle: add / remove / dedupe / trim ----------------------------------
{
  assert.deepEqual(toggleTrustedTool([], "mem0_memory"), ["mem0_memory"]);
  assert.deepEqual(toggleTrustedTool(undefined, "mem0_memory"), ["mem0_memory"]);
  // already trusted → removed
  assert.deepEqual(toggleTrustedTool(["mem0_memory"], "mem0_memory"), []);
  // trims input and stored entries, keeps order on add
  assert.deepEqual(toggleTrustedTool([" a ", "b"], "  c "), ["a", "b", "c"]);
  assert.deepEqual(toggleTrustedTool([" a ", "b"], "a"), ["b"]);
  // unknown/never-trustable names leave the list untouched
  assert.deepEqual(toggleTrustedTool(["a"], "bash"), ["a"]);
  assert.deepEqual(toggleTrustedTool(["a"], "   "), ["a"]);
  // input array is never mutated
  const original = ["a"];
  toggleTrustedTool(original, "b");
  assert.deepEqual(original, ["a"]);
  ok("toggle adds, removes, trims, dedupes and never mutates");
}

// --- isTrustedTool ---------------------------------------------------------
{
  assert.equal(isTrustedTool([" a ", "b"], "a"), true);
  assert.equal(isTrustedTool(["a"], " a "), true);
  assert.equal(isTrustedTool(["a"], "c"), false);
  assert.equal(isTrustedTool(undefined, "a"), false);
  assert.equal(isTrustedTool(["a"], "  "), false);
  ok("isTrustedTool is trim-insensitive and null-safe");
}

// --- round-trip: the preset toggle drives the whole section ----------------
{
  let list = [];
  for (const tool of COMMON_EXTENSION_TOOLS) list = toggleTrustedTool(list, tool.name);
  assert.ok(COMMON_EXTENSION_TOOLS.every((t) => isTrustedTool(list, t.name)), "all presets trusted after toggle");
  for (const tool of COMMON_EXTENSION_TOOLS) list = toggleTrustedTool(list, tool.name);
  assert.deepEqual(list, [], "toggling twice returns to empty");
  ok("preset toggle round-trips");
}

console.log(`\ntrusted-tools: ${passed} groups passed`);
