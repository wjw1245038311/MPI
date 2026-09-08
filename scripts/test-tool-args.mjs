import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const { extractEditPairs, normalizeTranscriptText } = await import("../src/renderer/src/lib/tool-args.ts");

// --- pi's real edit shape: edits[] array (multiple replacements) ------------
const piArgs = {
  path: "E:/proj/src/app.tsx",
  edits: [
    { oldText: "const a = 1;\nconsole.log(a);", newText: "const a = 2;" },
    { oldText: "export default App;", newText: "export default function App() {}" },
  ],
};
assert.deepEqual(extractEditPairs(piArgs), [
  { old: "const a = 1;\nconsole.log(a);", next: "const a = 2;" },
  { old: "export default App;", next: "export default function App() {}" },
]);

// --- single edit -------------------------------------------------------------
assert.deepEqual(extractEditPairs({ path: "x.ts", edits: [{ oldText: "a", newText: "b" }] }), [
  { old: "a", next: "b" },
]);

// --- flat top-level shape (other agents) --------------------------------------
assert.deepEqual(extractEditPairs({ file_path: "y.py", old_text: "x = 1", new_text: "x = 2" }), [
  { old: "x = 1", next: "x = 2" },
]);

// --- write shape has no before/after pairs ------------------------------------
assert.deepEqual(extractEditPairs({ path: "z.md", content: "# hello" }), []);

// --- null / empty --------------------------------------------------------------
assert.deepEqual(extractEditPairs(null), []);
assert.deepEqual(extractEditPairs({}), []);
assert.deepEqual(extractEditPairs({ edits: [] }), []);

// --- malformed entries are skipped, valid ones kept ----------------------------
assert.deepEqual(
  extractEditPairs({ path: "w.ts", edits: [null, "junk", { oldText: "keep" }, { newText: "only-new" }] }),
  [{ old: "keep", next: "" }, { old: "", next: "only-new" }],
);

// --- transport-level escapes are decoded (legacy/partial transcripts) ---------
assert.equal(normalizeTranscriptText("line1\\nline2"), "line1\nline2");
assert.deepEqual(extractEditPairs({ edits: [{ oldText: "a\\nb", newText: "c" }] }), [
  { old: "a\nb", next: "c" },
]);

// --- CRLF is normalized to LF ---------------------------------------------------
assert.equal(normalizeTranscriptText("a\r\nb\rc"), "a\nb\nc");

console.log("test-tool-args: all assertions passed");
