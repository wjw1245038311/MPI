// Regression tests for in-conversation search DOM marking (lib/search-mark).
// The marking code manipulates a real browser DOM, so it runs inside the
// project's own Electron/Chromium: esbuild bundles each test to an IIFE, a
// hidden BrowserWindow executes it, and results come back via window.__result.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = await import("esbuild");
const electronExe = require("electron"); // resolves to the .exe path under node context
const here = dirname(fileURLToPath(import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), "mpi-search-mark-"));
try {
  const tests = [
    ["dom-test.ts", "pure DOM marking: wrap/unwrap, nested spans, CJK, idempotency"],
    ["integration.tsx", "real React + react-markdown + highlight.js output -> markDom"],
  ];

  for (const [file, label] of tests) {
    const bundle = join(tmp, file.replace(/\.[a-z]+$/, ".bundle.js"));
    await esbuild.build({
      entryPoints: [join(here, "search-mark", file)],
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      outfile: bundle,
      logLevel: "silent",
    });
    const out = execFileSync(electronExe, [join(here, "search-mark", "runner.cjs"), bundle], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(out, /tests passed/, `${label}: runner did not report success:\n${out}`);
    console.log(`ok   ${file} (${label})`);
  }

  console.log("search-mark tests passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
