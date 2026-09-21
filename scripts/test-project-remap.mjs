import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

// Point pi's agent dir (session store) at a throwaway location BEFORE any
// module reads it — getAgentDir() resolves the env var on every call.
const agentDir = mkdtempSync(join(tmpdir(), "mpi-remap-agent-"));
process.env.PI_AGENT_DIR = agentDir;

const { loadConfig, updateConfig } = await import("../src/main/config.ts");
const userData = mkdtempSync(join(tmpdir(), "mpi-remap-userdata-"));
loadConfig(userData); // config.json / drafts.json / trash / todos live here

const { safeProjectDir, rewriteSessionHeaderCwd, remapProjectPath } = await import(
  "../src/main/data-migration.ts"
);
const { setDraft, flushDrafts } = await import("../src/main/draft-store.ts");

const sessionsRoot = join(agentDir, "sessions");
const header = (cwd) => JSON.stringify({ type: "session", version: 3, id: "test-id", timestamp: "2026-01-01T00:00:00.000Z", cwd });

// --- safeProjectDir encoding ------------------------------------------------
assert.ok(safeProjectDir("E:\\a\\b").startsWith("--") && safeProjectDir("E:\\a\\b").endsWith("--"));
assert.notEqual(safeProjectDir("E:\\Old\\Proj"), safeProjectDir("E:\\New\\Proj"));

// --- rewriteSessionHeaderCwd: header only, message content untouched --------
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-remap-hdr-"));
  const f = join(dir, "s.jsonl");
  const oldMsg = JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: `moved from E:\\Old\\Proj to somewhere` }] } });
  writeFileSync(f, [header("E:\\Old\\Proj"), oldMsg].join("\n") + "\n", "utf8");

  assert.equal(rewriteSessionHeaderCwd(f, "E:\\Old\\Proj", "E:\\New\\Proj"), 1);
  const lines = readFileSync(f, "utf8").split("\n");
  assert.equal(JSON.parse(lines[0]).cwd, "E:\\New\\Proj");
  assert.equal(lines[1], oldMsg, "message content mentioning the old path must stay untouched");

  // Idempotent: a second pass finds nothing to rewrite.
  assert.equal(rewriteSessionHeaderCwd(f, "E:\\Old\\Proj", "E:\\New\\Proj"), 0);
}

// --- full remap, per-project layout ------------------------------------------
{
  const oldCwd = join(tmpdir(), "mpi-remap-oldA"); // deliberately does not exist
  const newCwd = mkdtempSync(join(tmpdir(), "mpi-remap-newA-"));
  assert.ok(!existsSync(oldCwd));

  const projDir = join(sessionsRoot, safeProjectDir(oldCwd));
  mkdirSync(projDir, { recursive: true });
  const fileA = join(projDir, "a.jsonl");
  const fileB = join(projDir, "b.jsonl");
  writeFileSync(fileA, header(oldCwd) + "\n", "utf8");
  writeFileSync(fileB, [header(oldCwd), JSON.stringify({ type: "session", version: 3, id: "resume-id", timestamp: "2026-01-02T00:00:00.000Z", cwd: oldCwd })].join("\n") + "\n", "utf8");

  // Config references (cwd-keyed and file-path-keyed).
  updateConfig({
    pinnedProjects: [oldCwd],
    lastThreadCwd: oldCwd,
    pinnedThreads: [fileA],
    threadPermissions: { [fileA]: "full" },
    archivedThreads: [{ file: fileB, cwd: oldCwd, title: "t" }],
  });

  // Drafts through the store (memory + disk must agree).
  setDraft(`n:${oldCwd}`, { text: "hi", images: [], files: [{ abs: join(oldCwd, "docs", "a.md"), name: "a.md" }] });
  flushDrafts();

  // Trash index + agent-sourced todo link back to the session file.
  mkdirSync(join(userData, "trash"), { recursive: true });
  writeFileSync(join(userData, "trash", "index.json"), JSON.stringify([{ id: "x", originalFile: fileA }]), "utf8");
  writeFileSync(join(userData, "todos.json"), JSON.stringify([{ title: "t", sessionFile: fileB }]), "utf8");

  const res = remapProjectPath(oldCwd, newCwd);
  assert.equal(res.ok, true, `remap failed: ${JSON.stringify(res)}`);
  assert.equal(res.sessionsMoved, 2);
  assert.equal(res.headersUpdated, 3, "two files, one of them with a resume header line");

  // Session dir renamed; headers rewritten.
  assert.ok(!existsSync(projDir), "old session dir must be gone");
  const newProjDir = join(sessionsRoot, safeProjectDir(newCwd));
  assert.ok(existsSync(join(newProjDir, "a.jsonl")));
  assert.equal(JSON.parse(readFileSync(join(newProjDir, "a.jsonl"), "utf8").split("\n")[0]).cwd, newCwd);

  // Config references re-pointed.
  const cfg = JSON.parse(readFileSync(join(userData, "config.json"), "utf8"));
  assert.deepEqual(cfg.pinnedProjects, [newCwd]);
  assert.equal(cfg.lastThreadCwd, newCwd);
  assert.deepEqual(cfg.pinnedThreads, [join(newProjDir, "a.jsonl")]);
  assert.ok(cfg.threadPermissions[join(newProjDir, "a.jsonl")] === "full");
  assert.equal(Object.keys(cfg.threadPermissions).length, 1);
  assert.deepEqual(cfg.archivedThreads, [{ file: join(newProjDir, "b.jsonl"), cwd: newCwd, title: "t" }]);

  // Drafts re-keyed + attached file follows the project.
  const drafts = JSON.parse(readFileSync(join(userData, "drafts.json"), "utf8"));
  assert.ok(!(`n:${oldCwd}` in drafts), "old draft key must be gone");
  assert.equal(drafts[`n:${newCwd}`].text, "hi");
  assert.equal(drafts[`n:${newCwd}`].files[0].abs, join(newCwd, "docs", "a.md"));

  // Trash index + todo link follow the moved file.
  const trash = JSON.parse(readFileSync(join(userData, "trash", "index.json"), "utf8"));
  assert.equal(trash[0].originalFile, join(newProjDir, "a.jsonl"));
  const todos = JSON.parse(readFileSync(join(userData, "todos.json"), "utf8"));
  assert.equal(todos[0].sessionFile, join(newProjDir, "b.jsonl"));

  // Retry is a no-op (idempotent): nothing left to move or remap.
  const again = remapProjectPath(oldCwd, newCwd);
  assert.equal(again.ok, true);
  assert.equal(again.sessionsMoved, 0);
  assert.equal(again.headersUpdated, 0);
}

// --- error cases ---------------------------------------------------------------
{
  const target = mkdtempSync(join(tmpdir(), "mpi-remap-target-"));
  assert.equal(remapProjectPath(target, target).error, "same-path");
  assert.equal(remapProjectPath("E:\\Old\\X", join(tmpdir(), "mpi-remap-nope-missing")).error, "target-not-dir");
  assert.equal(remapProjectPath("", target).error, "invalid-args");
}

// --- refusing a non-empty existing session dir ----------------------------------
{
  const oldCwd = join(tmpdir(), "mpi-remap-oldB");
  const newCwd = mkdtempSync(join(tmpdir(), "mpi-remap-newB-"));
  // The project has session files…
  const projDirB = join(sessionsRoot, safeProjectDir(oldCwd));
  mkdirSync(projDirB, { recursive: true });
  writeFileSync(join(projDirB, "b.jsonl"), header(oldCwd) + "\n", "utf8");
  // …but another project already owns the target's session dir.
  const occupied = join(sessionsRoot, safeProjectDir(newCwd));
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, "other.jsonl"), header(newCwd) + "\n", "utf8");

  const res = remapProjectPath(oldCwd, newCwd);
  assert.equal(res.ok, false);
  assert.equal(res.error, "target-sessions-dir-exists");
}

// --- flat layout (custom session dir): headers in place, no file moves ----------
{
  const oldCwd = join(tmpdir(), "mpi-remap-oldC");
  const newCwd = mkdtempSync(join(tmpdir(), "mpi-remap-newC-"));
  const flatDir = mkdtempSync(join(tmpdir(), "mpi-remap-flat-"));
  updateConfig({ sessionStorageDir: flatDir });

  const f = join(flatDir, "flat.jsonl"); // no per-project subdir in flat layout
  writeFileSync(f, header(oldCwd) + "\n", "utf8");
  updateConfig({ pinnedProjects: [oldCwd] });

  const res = remapProjectPath(oldCwd, newCwd);
  assert.equal(res.ok, true, `flat remap failed: ${JSON.stringify(res)}`);
  assert.equal(res.sessionsMoved, 0, "flat layout files do not move");
  assert.equal(res.headersUpdated, 1);
  assert.equal(JSON.parse(readFileSync(f, "utf8").split("\n")[0]).cwd, newCwd);
  const cfg = JSON.parse(readFileSync(join(userData, "config.json"), "utf8"));
  assert.deepEqual(cfg.pinnedProjects, [newCwd]);
}

console.log("project remap tests passed");
