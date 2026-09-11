import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the tailer at a throwaway file BEFORE importing the module (it reads
// the env var at load time), so we never touch the real %TEMP% bridge file.
const TEST_FILE = path.join(os.tmpdir(), `mpi-release-progress-test-${Date.now()}.jsonl`);
process.env.MPI_RELEASE_PROGRESS_FILE = TEST_FILE;

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { applyProgressLine, consumeFile, newBridgeState } = await import(
  "../src/main/dev-release-progress.ts"
);
const { getTransfers } = await import("../src/main/transfer-monitor.ts");

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};
const writeLines = (lines) => fs.appendFileSync(TEST_FILE, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

try {
  // --- begin/update/end lifecycle -------------------------------------------
  const st = newBridgeState();
  applyProgressLine(st, { run: 1, op: "begin", id: "a.exe", label: "正在上传 a.exe", totalBytes: 1000 });
  assert.equal(getTransfers().length, 1);
  assert.equal(getTransfers()[0].kind, "upload");
  assert.equal(getTransfers()[0].totalBytes, 1000);
  ok("begin creates an upload entry with label/totalBytes");

  applyProgressLine(st, { run: 1, op: "update", id: "a.exe", doneBytes: 400, speedBps: 80_000 });
  assert.equal(getTransfers()[0].doneBytes, 400);
  assert.equal(getTransfers()[0].speedBps, 80_000);
  ok("update patches doneBytes and explicit speed");

  applyProgressLine(st, { run: 1, op: "end", id: "a.exe" });
  assert.equal(getTransfers().length, 0);
  ok("end removes the entry");

  // --- retry of the same asset (v0.6.5 scenario: 422 → delete → re-upload) --
  applyProgressLine(st, { run: 1, op: "begin", id: "a.exe", label: "正在上传 a.exe", totalBytes: 1000 });
  applyProgressLine(st, { run: 1, op: "end", id: "a.exe" });
  applyProgressLine(st, { run: 1, op: "begin", id: "a.exe", label: "正在上传 a.exe", totalBytes: 1000 });
  assert.equal(getTransfers().length, 1);
  ok("re-begin of the same asset replaces any leftover entry");

  // --- run change drops leftovers -------------------------------------------
  applyProgressLine(st, { run: 2, op: "begin", id: "b.exe", label: "正在上传 b.exe" });
  assert.equal(getTransfers().length, 1);
  assert.equal(getTransfers()[0].label, "正在上传 b.exe");
  ok("new run id drops entries from the previous run");

  // --- done op cleans up live entries ----------------------------------------
  applyProgressLine(st, { run: 2, op: "begin", id: "c.exe", label: "正在上传 c.exe" });
  assert.equal(getTransfers().length, 2);
  applyProgressLine(st, { run: 2, op: "done" });
  assert.equal(getTransfers().length, 0);
  ok("done drops all live entries");

  // --- consumeFile: offset tracking across appends ---------------------------
  fs.writeFileSync(TEST_FILE, "", "utf8");
  const st2 = newBridgeState();
  writeLines([{ run: 9, op: "begin", id: "x.exe", label: "正在上传 x.exe", totalBytes: 50 }]);
  consumeFile(st2);
  assert.equal(getTransfers().length, 1);
  ok("consumeFile picks up a begin line from the file");

  writeLines([
    { run: 9, op: "update", id: "x.exe", doneBytes: 50 },
    { run: 9, op: "end", id: "x.exe" },
  ]);
  consumeFile(st2); // only the new bytes are consumed (offset tracking)
  assert.equal(getTransfers().length, 0);
  ok("second consumeFile batch applies update+end without re-reading");

  // --- consumeFile: truncation by a new run ----------------------------------
  writeLines([{ run: 9, op: "begin", id: "y.exe", label: "正在上传 y.exe" }]);
  fs.writeFileSync(TEST_FILE, JSON.stringify({ run: 10, op: "begin", id: "z.exe", label: "正在上传 z.exe" }) + "\n", "utf8");
  consumeFile(st2);
  assert.equal(getTransfers().length, 1);
  assert.equal(getTransfers()[0].label, "正在上传 z.exe");
  ok("shrunken file (new run truncation) resets offset and drops old entries");

  // Clean up z.exe before the next case (the transfer registry is shared).
  applyProgressLine(st2, { run: 10, op: "end", id: "z.exe" });

  // --- consumeFile: stale writer ---------------------------------------------
  const st3 = newBridgeState();
  fs.writeFileSync(TEST_FILE, JSON.stringify({ run: 11, op: "begin", id: "w.exe", label: "正在上传 w.exe" }) + "\n", "utf8");
  consumeFile(st3);
  assert.equal(getTransfers().length, 1);
  consumeFile(st3, Date.now() + 31_000); // no new lines for >30s → writer dead
  assert.equal(getTransfers().length, 0);
  ok("stale timeout drops entries when the writer goes silent");

  // --- consumeFile: missing file ---------------------------------------------
  const st4 = newBridgeState();
  fs.writeFileSync(TEST_FILE, JSON.stringify({ run: 12, op: "begin", id: "v.exe", label: "正在上传 v.exe" }) + "\n", "utf8");
  consumeFile(st4);
  assert.equal(getTransfers().length, 1);
  fs.unlinkSync(TEST_FILE);
  consumeFile(st4);
  assert.equal(getTransfers().length, 0);
  ok("missing file (writer exited) drops live entries");

  console.log(`\nAll ${passed} release-progress-tail tests passed.`);
} finally {
  try { fs.unlinkSync(TEST_FILE); } catch { /* ignore */ }
}
