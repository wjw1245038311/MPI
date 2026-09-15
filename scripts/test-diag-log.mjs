/** Diag log writer tests — append + rotation. Backs the S3 field instrumentation
 * for the "composer greyed out / can't type" hunt (userData/logs/mpi-diag.log). */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { createDiagLogWriter } = await import("../src/main/diag-log.ts");

let passed = 0;
function ok(name) {
  passed++;
  console.log(`PASS ${name}`);
}

const dir = mkdtempSync(join(tmpdir(), "mpi-diag-"));
try {
  const file = join(dir, "logs", "mpi-diag.log");
  const write = createDiagLogWriter(file);

  // Appends JSON lines (creating parent dirs), preserves order, no double newline.
  write(JSON.stringify({ t: "2026-09-15T00:00:00Z", kind: "window-focus" }));
  write(JSON.stringify({ t: "2026-09-15T00:00:01Z", kind: "extui-queue", items: [] }) + "\n");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]).kind, "extui-queue");
  ok("appends JSON lines and creates parent directories");

  // Rotates to .old once the size limit (1MB) is exceeded.
  const big = JSON.stringify({ kind: "pad", data: "x".repeat(60_000) });
  for (let i = 0; i < 20; i++) write(big); // ~1.2MB total
  assert.ok(existsSync(file + ".old"), "rotation must create .old");
  const after = readFileSync(file, "utf8").trim().split("\n");
  assert.ok(after.length >= 1 && after.length < 20, `new file should hold only post-rotation lines (got ${after.length})`);
  ok("rotates to .old past the size limit");

  // A write failure must never throw — diagnostics cannot break the app.
  let threw = false;
  try {
    createDiagLogWriter(join(dir, "bad:name", "f.log"))("line"); // ':' is invalid in Windows paths
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  ok("never throws on unwritable paths");

  console.log(`\n${passed} groups passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
