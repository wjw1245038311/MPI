import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig, updateConfig } = await import("../src/main/config.ts");
const store = await import("../src/main/todo-store.ts");

const dir = mkdtempSync(join(tmpdir(), "mpi-todos-"));
loadConfig(dir); // points todo-store at a throwaway userData dir

// --- corrupt / partial file on first load: bad rows dropped, good kept -----
writeFileSync(
  join(dir, "todos.json"),
  JSON.stringify([
    { id: "good", title: "keep me", cwd: "/p1", dueDate: null, done: false, createdAt: 1 },
    { title: "" }, // no title -> dropped
    "garbage", // not an object -> dropped
    { id: "bad-date", title: "x", dueDate: "2026-02-30" }, // impossible date -> nulled, kept
  ]),
);
let list = store.listTodos();
assert.equal(list.length, 2, "invalid rows must be dropped on load");
const badDate = list.find((t) => t.id === "bad-date");
assert.equal(badDate.dueDate, null, "impossible calendar date must normalize to null");

// --- add + scoping ----------------------------------------------------------
store.deleteTodo("good");
store.deleteTodo("bad-date");
const a = store.addTodo({ cwd: "/p1", title: "  write docs  ", dueDate: "2026-09-30" });
assert.ok(a && a.title === "write docs", "title is trimmed");
store.addTodo({ cwd: "/p1", title: "ship it", dueDate: "2026-13-01" }); // invalid month -> null
store.addTodo({ cwd: "/p2", title: "other project task" });
assert.equal(store.listTodos().length, 3);
const p1 = store.listTodos().filter((t) => t.cwd === "/p1");
assert.equal(p1.length, 2);
assert.equal(p1[1].dueDate, null, "invalid dueDate must be stored as null");

// --- update -----------------------------------------------------------------
const ship = store.listTodos().find((t) => t.title === "ship it");
let updated = store.updateTodo(ship.id, { note: "", dueDate: "2026-10-01" });
assert.equal(updated.dueDate, "2026-10-01");
updated = store.updateTodo(ship.id, { title: "ship v2", note: "with notes" });
assert.equal(updated.title, "ship v2");
assert.equal(updated.note, "with notes");
assert.equal(store.updateTodo(ship.id, { title: "   " }), null, "empty title must be rejected");
updated = store.updateTodo(ship.id, { note: "" });
assert.equal(updated.note, undefined, "empty note clears the field");
assert.equal(store.updateTodo("missing", { title: "x" }), null);

// --- toggle -----------------------------------------------------------------
const docs = store.listTodos().find((t) => t.title === "write docs");
let toggled = store.toggleTodo(docs.id);
assert.ok(toggled.done && typeof toggled.completedAt === "number");
toggled = store.toggleTodo(docs.id);
assert.ok(!toggled.done && toggled.completedAt === null);

// --- clear completed (scoped + global) --------------------------------------
store.toggleTodo(ship.id); // done in /p1
const other = store.listTodos().find((t) => t.cwd === "/p2");
store.toggleTodo(other.id); // done in /p2
assert.equal(store.clearCompletedTodos("/p1"), 1, "scoped clear removes only that project");
assert.equal(store.listTodos().length, 2);
assert.equal(store.clearCompletedTodos(null), 1, "global clear removes the rest");
assert.equal(store.listTodos().length, 1);

// --- delete -----------------------------------------------------------------
const last = store.listTodos()[0];
assert.ok(store.deleteTodo(last.id));
assert.ok(!store.deleteTodo("nope"));
assert.equal(store.listTodos().length, 0);

// --- persistence: coalesced atomic flush ------------------------------------
const persisted = store.addTodo({ cwd: "/p1", title: "persisted" });
store.flushTodos();
const onDisk = JSON.parse(readFileSync(join(dir, "todos.json"), "utf8"));
assert.equal(onDisk.length, 1);
assert.equal(onDisk[0].title, "persisted");

// --- inbox: agent-side additions --------------------------------------------
mkdirSync(store.inboxDir(), { recursive: true });
writeFileSync(
  join(store.inboxDir(), "t1.json"),
  JSON.stringify({ id: "agent-1", title: "from agent", cwd: "/p1", dueDate: null, done: false, createdAt: 2, source: "agent", sessionFile: "s1" }),
);
writeFileSync(join(store.inboxDir(), "dup.json"), JSON.stringify({ id: persisted.id, title: "duplicate id", cwd: "/p1", dueDate: null, done: false, createdAt: 3 }));
writeFileSync(join(store.inboxDir(), "bad.json"), "{ not json");
const added = store.ingestInbox();
assert.equal(added.length, 1, "only the valid new inbox item is added");
assert.equal(added[0].id, "agent-1");
assert.equal(store.listTodos().length, 2);
// second ingest: nothing new; corrupt file left for inspection, consumed files are gone
assert.deepEqual(store.ingestInbox(), []);
const remainingFiles = readdirSync(join(dir, "todos-inbox"));
assert.ok(remainingFiles.includes("bad.json"), "corrupt inbox file must be left for inspection");
assert.ok(!remainingFiles.includes("dup.json"), "consumed inbox file must be deleted");
store.flushTodos();

// --- attachments: dedupe + configurable storage dir -------------------------
const attTodo = store.addTodo({ cwd: "/p1", title: "with attachment" });
const shot = { name: "shot.png", mime: "image/png", data: Buffer.from([1, 2, 3, 4]) };
let attOut = store.addAttachments(attTodo.id, [shot]);
assert.equal(attOut.added, 1);
assert.deepEqual(attOut.skipped, []);
attOut = store.addAttachments(attTodo.id, [{ ...shot }]); // same name+size again
assert.equal(attOut.added, 0, "same file (name+size) must not be attached twice");
assert.deepEqual(attOut.skipped, ["shot.png"]);
let atts = store.listTodos().find((t) => t.id === attTodo.id).attachments;
assert.equal(atts.length, 1, "dedupe must keep a single attachment row");

// custom dir: new files land there; pre-existing ones still resolve from default
updateConfig({ todoAttachmentDir: join(dir, "custom-att") });
const fresh = { name: "new.png", mime: "image/png", data: Buffer.from([9, 9]) };
attOut = store.addAttachments(attTodo.id, [fresh]);
assert.equal(attOut.added, 1);
atts = store.listTodos().find((t) => t.id === attTodo.id).attachments;
const freshAtt = atts.find((a) => a.name === "new.png");
assert.ok(existsSync(join(dir, "custom-att", freshAtt.file)), "new file must be written to the custom dir");
const oldAtt = atts.find((a) => a.name === "shot.png");
assert.ok(store.resolveAttachmentFile(oldAtt.file), "pre-existing file must resolve from the default dir");
// removing it unlinks the file even though it lives in the other dir
const afterRemove = store.removeAttachment(attTodo.id, oldAtt.id);
assert.equal(afterRemove.attachments.length, 1);
assert.ok(!existsSync(join(dir, "todo-attachments", oldAtt.file)), "old-dir file must be unlinked on removal");
updateConfig({ todoAttachmentDir: "" }); // back to default
store.flushTodos();

console.log("todo store tests passed");
