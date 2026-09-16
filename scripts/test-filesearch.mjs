import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig } = await import("../src/main/config.ts");
const { searchProjectFiles } = await import("../src/main/fs-service.ts");
const { sessionMentionItems } = await import("../src/renderer/src/lib/mention.ts");
const { deleteFeedback, flushFeedback, getFeedback, setFeedback } = await import(
  "../src/main/feedback-store.ts"
);

// ---------------------------------------------------------------------------
// Fixture tree
//   proj/
//     README.md
//     src/
//       renderer/
//         components/Chat.tsx
//         Chat.css
//       main/ipc.ts
//     docs/guide.md
//     node_modules/junk/file.js      (ignored subtree)
//     .hidden/secret.txt             (dotfile dir, ignored)
//     .env                           (allowed dotfile)
//     link -> src                    (symlink, skipped)
// ---------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "mpi-filesearch-"));
try {
  const proj = join(root, "proj");
  for (const dir of ["src/renderer/components", "src/main", "docs", "node_modules/junk", ".hidden"]) {
    mkdirSync(join(proj, dir), { recursive: true });
  }
  writeFileSync(join(proj, "README.md"), "# hi");
  writeFileSync(join(proj, "src/renderer/components/Chat.tsx"), "x");
  writeFileSync(join(proj, "src/renderer/components/Chat.css"), "x");
  writeFileSync(join(proj, "src/main/ipc.ts"), "x");
  writeFileSync(join(proj, "docs/guide.md"), "x");
  writeFileSync(join(proj, "docs/chat.txt"), "x"); // exact-basename match for tier tests
  writeFileSync(join(proj, "node_modules/junk/file.js"), "x");
  writeFileSync(join(proj, ".hidden/secret.txt"), "x");
  writeFileSync(join(proj, ".env"), "x");
  symlinkSync(join(proj, "src"), join(proj, "link"));

  const names = (res) => res.map((n) => n.rel);

  // --- bare "@": top level only, dirs first ---------------------------------
  const top = searchProjectFiles(proj, "");
  assert.deepEqual(
    names(top),
    ["src", "docs", ".env", "README.md"],
    `bare @ lists the top level (dirs first): ${names(top)}`,
  );

  // --- exact basename beats prefix beats substring ---------------------------
  const chat = searchProjectFiles(proj, "chat");
  assert.equal(
    chat[0].rel,
    "docs/chat.txt",
    `exact basename (tier 0) first: ${names(chat)}`,
  );
  for (const rel of ["src/renderer/components/Chat.tsx", "src/renderer/components/Chat.css"]) {
    assert.ok(chat.some((n) => n.rel === rel), `prefix match present: ${rel} in ${names(chat)}`);
  }

  // --- path-prefix query prunes and keeps the dir itself ahead ---------------
  const srcComp = searchProjectFiles(proj, "src/renderer");
  assert.equal(srcComp[0].rel, "src/renderer", `path prefix: dir first: ${names(srcComp)}`);
  assert.ok(
    srcComp.every((n) => n.rel.startsWith("src/renderer")),
    `pruned to the subtree: ${names(srcComp)}`,
  );

  // --- ignored subtrees and dotfiles never surface ---------------------------
  const all = searchProjectFiles(proj, ".", 200); // substring: every dotted file
  assert.ok(all.length >= 5, `dot query finds the fixture files: ${names(all)}`);
  assert.ok(!all.some((n) => n.rel.includes("node_modules")), "node_modules excluded");
  const hidden = searchProjectFiles(proj, "secret", 100);
  assert.equal(hidden.length, 0, ".hidden/ dotfile dir excluded");

  // --- symlinks are skipped (no cycle through link/) -------------------------
  const viaLink = searchProjectFiles(proj, "link/", 100);
  assert.equal(viaLink.length, 0, `symlink not followed: ${names(viaLink)}`);

  // --- limit is respected -----------------------------------------------------
  assert.ok(searchProjectFiles(proj, ".", 3).length <= 3, "limit honored");

  console.log("filesearch: all assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Feedback store (sidecar JSON under a throwaway userData dir)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// @mention session group (对话) — pure renderer lib, no fs involved
// ---------------------------------------------------------------------------
{
  const projects = [
    {
      cwd: "E:\\proj\\a",
      name: "alpha",
      threads: [
        { file: "s1.jsonl", id: "t1", title: "重构 Composer", preview: "", updatedAt: 300, messageCount: 5 },
        { file: "s2.jsonl", id: "t2", title: "fix bug", preview: "", updatedAt: 100, messageCount: 2 },
      ],
    },
    {
      cwd: "E:\\proj\\b",
      name: "beta",
      threads: [
        { file: "s3.jsonl", id: "t3", title: "重构 Sidebar", preview: "", updatedAt: 200, messageCount: 9 },
        // corrupt row without a file — must be skipped
        { file: "", id: "t4", title: "ghost", preview: "", updatedAt: 999, messageCount: 1 },
      ],
    },
  ];

  // bare @: most recent first across projects
  const all = sessionMentionItems(projects, "");
  assert.deepEqual(
    all.map((i) => i.file),
    ["s1.jsonl", "s3.jsonl", "s2.jsonl"],
    `recent-first order: ${all.map((i) => i.file)}`,
  );

  // query matches title (case-insensitive)
  const byTitle = sessionMentionItems(projects, "FIX");
  assert.deepEqual(byTitle.map((i) => i.file), ["s2.jsonl"]);

  // query also matches project name
  const byProject = sessionMentionItems(projects, "beta");
  assert.deepEqual(byProject.map((i) => i.file), ["s3.jsonl"]);

  // the current conversation is excluded
  const excl = sessionMentionItems(projects, "", "s1.jsonl");
  assert.ok(!excl.some((i) => i.file === "s1.jsonl"), "current thread excluded");

  // limit honored
  assert.equal(sessionMentionItems(projects, "", null, 2).length, 2);

  console.log("mention-sessions: all assertions passed");
}

const dataDir = mkdtempSync(join(tmpdir(), "mpi-feedback-"));
try {
  loadConfig(dataDir); // points feedback-store at the throwaway dir

  assert.deepEqual(getFeedback(), {}, "starts empty");

  setFeedback("01ABC", 1);
  assert.equal(getFeedback()["01ABC"].rating, 1);

  // note undefined keeps the existing note; a string replaces it
  setFeedback("01ABC", 1, "great fix");
  assert.equal(getFeedback()["01ABC"].note, "great fix");
  setFeedback("01ABC", -1); // switch sides, keep note (dsh parity)
  const switched = getFeedback()["01ABC"];
  assert.equal(switched.rating, -1);
  assert.equal(switched.note, "great fix");

  // null clears the note; empty string also clears
  setFeedback("01ABC", -1, "");
  assert.equal(getFeedback()["01ABC"].note, undefined);

  // re-clicking the active rating retracts (delete)
  deleteFeedback("01ABC");
  assert.deepEqual(getFeedback(), {}, "retract removes the entry");

  // persistence: flush then read the raw JSON back
  setFeedback("01DEF", -1, "note");
  flushFeedback();
  const onDisk = JSON.parse(readFileSync(join(dataDir, "feedback.json"), "utf8"));
  assert.equal(onDisk["01DEF"].rating, -1);
  assert.equal(onDisk["01DEF"].note, "note");

  // note length is capped at 500 chars
  setFeedback("01GHI", 1, "x".repeat(900));
  assert.equal(getFeedback()["01GHI"].note.length, 500);

  console.log("feedback-store: all assertions passed");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
