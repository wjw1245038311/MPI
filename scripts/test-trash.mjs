import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig, updateConfig } = await import("../src/main/config.ts");
const trash = await import("../src/main/trash-store.ts");

const userData = mkdtempSync(join(tmpdir(), "mpi-trash-"));
loadConfig(userData); // points trash-store at a throwaway userData dir

// Fake pi session store layout (trash only cares about absolute paths).
const sessionsDir = join(userData, "fake-sessions", "proj-a");
mkdirSync(sessionsDir, { recursive: true });
const makeSession = (name) => {
  const p = join(sessionsDir, name);
  writeFileSync(p, '{"type":"message","content":"hi"}\n');
  return p;
};

// --- trashEnabled default + persistence --------------------------------------
assert.equal(loadConfig(userData).trashEnabled, true, "absent flag defaults to enabled (safe)");
updateConfig({ trashEnabled: false });
assert.equal(loadConfig(userData).trashEnabled, false, "explicit false must persist");
updateConfig({ trashEnabled: true });

// --- moveToTrash + list -------------------------------------------------------
const s1 = makeSession("s1.jsonl");
const e1 = await trash.moveToTrash({ originalFile: s1, title: "会话一", cwd: "C:\\proj\\a" });
assert.ok(!existsSync(s1), "source file must be gone from the session store");
assert.equal(e1.originalFile, s1);
assert.equal(e1.title, "会话一");
assert.equal(e1.cwd, "C:\\proj\\a");
assert.ok(e1.sizeBytes > 0);

const s2 = makeSession("s2.jsonl");
const e2 = await trash.moveToTrash({ originalFile: s2 }); // no title/cwd -> empty strings
assert.equal(e2.title, "", "missing title degrades to an empty string");
let list = trash.listTrash();
assert.equal(list.length, 2);
assert.deepEqual(
  list.map((e) => e.id),
  [e2.id, e1.id],
  "newest entry first",
);

// --- index persistence across a fresh module instance -------------------------
const fresh = await import("../src/main/trash-store.ts?reload=1");
assert.deepEqual(
  fresh.listTrash().map((e) => e.originalFile),
  [s2, s1],
  "index must survive a process restart (re-read from index.json, newest first)",
);

// --- restore: file returns, entry disappears, parent dir recreated ------------
rmSync(sessionsDir, { recursive: true }); // simulate pi's per-project subdir being removed
const restored = fresh.restoreFromTrash(e1.id);
assert.equal(restored.originalFile, s1);
assert.ok(existsSync(s1), "session file must be back at its original path");
assert.deepEqual(
  fresh.listTrash().map((e) => e.id),
  [e2.id],
  "restored entry leaves the trash",
);

// --- restore conflict: a session already exists at the target -----------------
const s3 = makeSession("s3.jsonl");
const e3 = await fresh.moveToTrash({ originalFile: s3, title: "冲突" });
writeFileSync(s3, '{"type":"message"}\n'); // something recreated the file meanwhile
assert.throws(() => fresh.restoreFromTrash(e3.id), /already exists/);

// --- list prunes entries whose file vanished from disk ------------------------
rmSync(join(userData, "trash", `${e3.id}.jsonl`));
assert.deepEqual(
  fresh.listTrash().map((e) => e.id),
  [e2.id],
  "orphaned index rows are pruned on list",
);

// --- purge + empty -------------------------------------------------------------
const a = await fresh.moveToTrash({ originalFile: makeSession("a.jsonl") });
const b = await fresh.moveToTrash({ originalFile: makeSession("b.jsonl") });
fresh.purgeFromTrash(a.id);
assert.deepEqual(fresh.listTrash().map((e) => e.id), [b.id, e2.id]);
assert.throws(() => fresh.purgeFromTrash(a.id), /not found/);
const count = fresh.emptyTrash();
assert.equal(count, 2);
assert.deepEqual(fresh.listTrash(), []);

// --- corrupt index -> empty list, no crash ------------------------------------
writeFileSync(join(userData, "trash", "index.json"), "{not json");
const fresh2 = await import("../src/main/trash-store.ts?reload=2");
assert.deepEqual(fresh2.listTrash(), [], "corrupt index degrades to an empty trash");

console.log("trash store: all tests passed");
