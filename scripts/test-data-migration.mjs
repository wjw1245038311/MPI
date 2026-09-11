// Data-location migration tests (Settings → 数据存储).
// Run: npm run test:migration   (node --experimental-strip-types)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "mpi-mig-"));
// Point pi's agent dir at a sandbox BEFORE any config/session-store calls so
// remapSessionReferences never touches the real ~/.pi/agent.
process.env.PI_AGENT_DIR = join(root, "agent");
const agentDir = process.env.PI_AGENT_DIR;

const userData = join(root, "userData");
mkdirSync(userData, { recursive: true });

const { loadConfig, updateConfig, getConfig } = await import("../src/main/config.ts");
loadConfig(userData);

const dm = await import("../src/main/data-migration.ts");
const ss = await import("../src/main/session-store.ts");

// Fake project dirs used as session-file header cwds (real paths so the
// safeProjectDir encoding is exercised end to end).
const projA = join(root, "projA");
const projB = join(root, "projB");
mkdirSync(projA);
mkdirSync(projB);

// --- validateTargetDir -------------------------------------------------------
assert.equal(dm.validateTargetDir(""), "empty");
assert.equal(dm.validateTargetDir("relative/path"), "not-absolute"); // raw input checked pre-resolve
assert.equal(dm.validateTargetDir(userData), "is-config-dir");
assert.equal(dm.validateTargetDir(join(root, "ok")), null);

// --- sessions: preview + set + migrate on "next launch" ----------------------
const defaultSessions = ss.defaultSessionsDir();
mkdirSync(join(defaultSessions, dm.safeProjectDir(projB)), { recursive: true }); // pi's per-project nesting
// JSON.stringify so Windows backslashes in the cwd are valid JSON escapes.
writeFileSync(join(defaultSessions, "loose.jsonl"), `${JSON.stringify({ cwd: projA })}\n`);
writeFileSync(
  join(defaultSessions, dm.safeProjectDir(projB), "a.jsonl"),
  `${JSON.stringify({ cwd: projB })}\n`,
);

const customSessions = join(root, "custom-sessions");
mkdirSync(customSessions, { recursive: true });

let preview = dm.previewMigration("sessions", customSessions);
assert.equal(preview.ok, true);
assert.equal(preview.count, 2); // loose + nested (pi's per-project subdirs)
assert.equal(preview.pending, false);

// Same dir as current effective location → nothing to move.
preview = dm.previewMigration("sessions", defaultSessions);
assert.equal(preview.ok, true);
assert.equal(preview.count, 0);

let res = dm.setSessionsDir(customSessions);
assert.equal(res.ok, true);
assert.equal(res.pending, true);
assert.equal(res.count, 2);
assert.equal(getConfig().sessionStorageDir, customSessions);
// Live switch: the app reads from the new dir immediately (old files still there).
assert.equal(ss.getSessionsDir(), customSessions);

// Simulate next launch. Custom session dirs are FLAT (pi's sessionDir layout),
// so nested files move out of their per-project subdirectory.
let summary = dm.runPendingDataMigrations();
assert.ok(summary, "expected a migration summary");
assert.equal(summary.sessionsMoved, 2);
assert.deepEqual(summary.errors, []);
assert.equal(existsSync(join(customSessions, "loose.jsonl")), true);
assert.equal(existsSync(join(customSessions, "a.jsonl")), true); // flattened
assert.equal(existsSync(join(defaultSessions, "loose.jsonl")), false);
assert.equal(getConfig().pendingDataMigration?.sessions, undefined);

// settings.json remap so terminal pi follows the new location.
const agentSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
assert.equal(agentSettings.sessionDir, customSessions);

// --- todos: default + legacy attachment dir + inbox --------------------------
writeFileSync(join(userData, "todos.json"), '[]\n');
mkdirSync(join(userData, "todo-attachments"), { recursive: true });
writeFileSync(join(userData, "todo-attachments", "x.png"), "PNG");
const legacyAtt = join(root, "legacy-att"); // an older custom attachment dir
updateConfig({ todoAttachmentDir: legacyAtt });
mkdirSync(legacyAtt, { recursive: true });
writeFileSync(join(legacyAtt, "old.pdf"), "PDF");
mkdirSync(join(userData, "todos-inbox"), { recursive: true });
writeFileSync(join(userData, "todos-inbox", "in.json"), '{"title":"from agent"}');

const customTodos = join(root, "custom-todos");
mkdirSync(customTodos, { recursive: true });

res = dm.setTodosDir(customTodos);
assert.equal(res.ok, true);
assert.equal(res.pending, true);
assert.equal(res.count, 4); // todos.json + x.png + old.pdf (legacy) + in.json
assert.equal(getConfig().todoDataDir, customTodos);

summary = dm.runPendingDataMigrations();
assert.equal(summary.todoFilesMoved, 4);
assert.deepEqual(summary.errors, []);
assert.equal(existsSync(join(customTodos, "todos.json")), true);
assert.equal(readFileSync(join(customTodos, "todos.json"), "utf8").trim(), "[]");
assert.equal(existsSync(join(customTodos, "todo-attachments", "x.png")), true);
assert.equal(existsSync(join(customTodos, "todo-attachments", "old.pdf")), true); // legacy merged in
assert.equal(existsSync(join(customTodos, "todos-inbox", "in.json")), true);
// Legacy override is superseded by todoDataDir once the move succeeds.
assert.equal(getConfig().todoAttachmentDir, undefined);

// Everything now lives inside the target → re-planning finds nothing to move.
const replan = dm.planTodoMigration(customTodos);
assert.equal(replan.count, 0);

// --- collision: pre-existing todos.json in the target is never clobbered -----
const customTodos2 = join(root, "custom-todos-2");
mkdirSync(customTodos2, { recursive: true });
writeFileSync(join(customTodos2, "todos.json"), '[{"title":"kept"}]\n');

res = dm.setTodosDir(customTodos2);
assert.equal(res.ok, true); // intent recorded; the move itself refuses at run time
summary = dm.runPendingDataMigrations();
assert.equal(summary.todoFilesMoved, 0);
assert.ok(summary.errors.some((e) => e.includes("todos.json")));
// Source untouched, target untouched, pending kept for retry.
assert.equal(existsSync(join(customTodos, "todos.json")), true);
assert.equal(readFileSync(join(customTodos2, "todos.json"), "utf8").includes("kept"), true);
assert.ok(getConfig().pendingDataMigration?.todos);

// --- restore default (null) migrates back into per-project subdirs -----------
res = dm.setSessionsDir(null);
assert.equal(res.ok, true);
assert.equal(res.pending, true);
summary = dm.runPendingDataMigrations();
assert.equal(summary.sessionsMoved, 2); // both files carry a cwd header → re-nested
// The collision's pending.todos still retries every launch by design — only
// session-related errors must be clean here.
assert.deepEqual(
  summary.errors.filter((e) => !e.startsWith("todos:")),
  [],
);
assert.equal(existsSync(join(defaultSessions, dm.safeProjectDir(projA), "loose.jsonl")), true);
assert.equal(existsSync(join(defaultSessions, dm.safeProjectDir(projB), "a.jsonl")), true);
assert.equal(getConfig().sessionStorageDir, undefined);
// pi's settings.json key is removed again (terminal pi back to default).
const agentSettings2 = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
assert.equal(agentSettings2.sessionDir, undefined);

console.log("data-migration tests passed");
