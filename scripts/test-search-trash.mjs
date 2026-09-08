import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig } = await import("../src/main/config.ts");
const trash = await import("../src/main/trash-store.ts");
const store = await import("../src/main/session-store.ts");

const userData = mkdtempSync(join(tmpdir(), "mpi-search-trash-"));
loadConfig(userData); // points the trash dir at a throwaway userData

// Realistic session JSONL files (header carries cwd; messages nest under .message).
const sessionsDir = join(userData, "fake-sessions", "proj-a");
mkdirSync(sessionsDir, { recursive: true });
const fileA = join(sessionsDir, "a.jsonl");
writeFileSync(
  fileA,
  [
    JSON.stringify({ type: "session", cwd: "C:\\proj\\a", timestamp: "2026-09-01T10:00:00Z" }),
    JSON.stringify({ type: "session_info", name: "zebra 测试会话" }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "please find the zebra keyword" }] },
      timestamp: "2026-09-01T10:00:05Z",
    }),
  ].join("\n") + "\n",
);
const fileB = join(sessionsDir, "b.jsonl");
writeFileSync(
  fileB,
  [
    JSON.stringify({ type: "session", cwd: "C:\\proj\\a", timestamp: "2026-09-02T10:00:00Z" }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "nothing to see here" }] },
      timestamp: "2026-09-02T10:00:05Z",
    }),
  ].join("\n") + "\n",
);

await trash.moveToTrash({ originalFile: fileA, title: "zebra 测试会话", cwd: "C:\\proj\\a" });
await trash.moveToTrash({ originalFile: fileB, title: "无关会话", cwd: "C:\\proj\\a" });

// Only the matching trashed session is found, tagged state="trashed".
const hits = await store.searchTrashThreads("zebra");
assert.equal(hits.length, 1, "exactly one trashed hit for 'zebra'");
assert.equal(hits[0].state, "trashed");
assert.equal(hits[0].cwd, "C:\\proj\\a", "cwd comes from the JSONL header");
assert.ok(hits[0].file.includes(join(userData, "trash")), "hit file lives in the trash dir");
assert.ok(hits[0].matchCount >= 1);

// Title match also works (session_info name).
const byTitle = await store.searchTrashThreads("测试会话");
assert.equal(byTitle.length, 1);
assert.equal(byTitle[0].title, "zebra 测试会话");

// Blank query is a no-op.
assert.deepEqual(await store.searchTrashThreads("   "), []);

rmSync(userData, { recursive: true, force: true });
console.log("search-trash: all tests passed");
