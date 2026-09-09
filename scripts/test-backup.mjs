import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const backup = await import("../src/main/backup.ts");
const { sanitizeImportedConfig } = await import("../src/main/config.ts");
const JSZip = (await import("jszip")).default;

const tmp = mkdtempSync(join(tmpdir(), "mpi-backup-"));
try {
  /* ------------------------------ config ---------------------------------- */

  const sampleConfig = {
    piCliPath: "C:\\old\\machine\\cli.js", // must be excluded (machine-specific)
    windowBounds: { x: 1, y: 2, width: 800, height: 600 }, // must be excluded
    theme: "dark",
    accentTheme: "green",
    zoomPercent: 120,
    language: "zh",
    soundOnComplete: false,
    diffViewMode: "blocks",
    defaultPermission: "strict",
    trashEnabled: true,
    pinnedProjects: ["C:\\proj\\a"],
    pinnedThreads: ["C:\\sessions\\x.jsonl"],
    archivedProjects: [],
    archivedThreads: [{ file: "f1.jsonl", cwd: "C:\\p", title: "t1", archivedAt: 5 }],
    threadPermissions: { "a.jsonl": "full", "b.jsonl": "weird" },
    userAvatar: "data:image/png;base64,AAA",
    agentAvatar: "http://evil.example/x.png", // must be excluded (not a data URL)
    userProfile: "我是测试用户",
    lastThreadCwd: "C:\\proj\\a",
    automationTasks: [
      { id: "t1", name: "n", cwd: "c", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, enabled: true, permission: "full" },
      { id: "", name: "bad", cwd: "c", prompt: "p", schedule: { frequency: "daily" }, enabled: true }, // dropped (no id)
      { id: "t2", name: "n2", cwd: "c", prompt: "p", schedule: { frequency: "monthly" }, enabled: false, permission: "weird" }, // dropped (bad freq)
    ],
    remoteSignalingUrl: "  wss://example.com/ws  ",
    remoteSignalingEnabled: true,
    theme2: "ignored-unknown-key",
  };

  const sanitized = sanitizeImportedConfig(sampleConfig);
  assert.equal(sanitized.theme, "dark");
  assert.equal(sanitized.accentTheme, "green");
  assert.equal(sanitized.zoomPercent, 120);
  assert.equal(sanitized.language, "zh");
  assert.deepEqual(sanitized.pinnedProjects, ["C:\\proj\\a"]);
  assert.deepEqual(sanitized.archivedThreads, [{ file: "f1.jsonl", cwd: "C:\\p", title: "t1", archivedAt: 5 }]);
  assert.deepEqual(sanitized.threadPermissions, { "a.jsonl": "full" }, "invalid per-thread level dropped");
  assert.equal(sanitized.userAvatar, "data:image/png;base64,AAA");
  assert.ok(!("agentAvatar" in sanitized), "non-data-URL avatar rejected");
  assert.equal(sanitized.userProfile, "我是测试用户");
  assert.deepEqual(sanitized.automationTasks, [
    { id: "t1", name: "n", cwd: "c", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, enabled: true, permission: "full" },
  ]);
  assert.equal(sanitized.remoteSignalingUrl, "wss://example.com/ws", "signaling url trimmed");
  assert.ok(!("piCliPath" in sanitized), "machine-specific piCliPath never imported");
  assert.ok(!("windowBounds" in sanitized), "machine-specific windowBounds never imported");
  assert.ok(!("theme2" in sanitized), "unknown keys dropped");

  // Invalid values are excluded, not defaulted.
  const partial = sanitizeImportedConfig({ theme: "weird", zoomPercent: 999, language: "fr", userProfile: "" });
  assert.equal(partial.zoomPercent, 150, "zoom clamped into range");
  assert.ok(!("theme" in partial) && !("language" in partial), "invalid enum values excluded");
  assert.equal(partial.userProfile, "", "empty profile is a valid value (disables injection)");

  // Build + parse round-trip (wrapped document and raw config both accepted).
  const doc = JSON.parse(backup.buildConfigBackup(sampleConfig, "0.5.3").toString("utf8"));
  assert.equal(doc.app, "MPI");
  assert.equal(doc.kind, "config");
  assert.equal(doc.version, backup.BACKUP_FORMAT_VERSION);
  assert.ok(doc.exportedAt && doc.appVersion === "0.5.3");
  assert.deepEqual(backup.parseConfigBackup(JSON.stringify(doc)), sampleConfig);
  assert.deepEqual(backup.parseConfigBackup(JSON.stringify({ theme: "dark" })), { theme: "dark" });
  assert.deepEqual(backup.parseConfigBackup("{}"), {}, "empty object parses to empty settings");
  assert.throws(() => backup.parseConfigBackup("not json"));
  assert.throws(() => backup.parseConfigBackup("[1,2]"));

  /* ------------------------------ sessions -------------------------------- */

  const root = join(tmp, "sessions");
  mkdirSync(join(root, "proj-a"), { recursive: true });
  mkdirSync(join(root, "proj-b"), { recursive: true });
  writeFileSync(join(root, "proj-a", "s1.jsonl"), '{"type":"session","id":"a"}\n');
  writeFileSync(join(root, "proj-a", "s2.jsonl"), '{"type":"message"}\n{"type":"message"}\n');
  writeFileSync(join(root, "proj-b", "s3.jsonl"), '{"x":1}\n');
  writeFileSync(join(root, "proj-a", "notes.txt"), "not a session"); // ignored

  const groups = backup.listBackupProjects(root);
  assert.deepEqual(
    groups.map((g) => [g.dirName, g.count]),
    [["proj-a", 2], ["proj-b", 1]],
    "grouped by dir, sorted, non-jsonl ignored",
  );
  assert.ok(groups[0].totalBytes > 0);

  // Export → inspect (fresh root: everything new) → import skip.
  const zipPath = join(tmp, "backup.zip");
  const count = await backup.exportSessionsZip(zipPath, ["proj-a", "proj-b"], "0.5.3", root);
  assert.equal(count, 3);

  const freshRoot = join(tmp, "restored");
  let summary = await backup.inspectSessionBackup(zipPath, freshRoot);
  assert.deepEqual([summary.total, summary.newCount, summary.existingCount], [3, 3, 0]);

  let r = await backup.importSessionZip(zipPath, "skip", freshRoot);
  assert.deepEqual(r, { imported: 3, skipped: 0, overwritten: 0 });
  assert.ok(existsSync(join(freshRoot, "proj-a", "s1.jsonl")));
  assert.equal(readFileSync(join(freshRoot, "proj-a", "s2.jsonl"), "utf8"), '{"type":"message"}\n{"type":"message"}\n');

  // Re-import into the same root: everything exists → skip leaves it alone.
  summary = await backup.inspectSessionBackup(zipPath, freshRoot);
  assert.deepEqual([summary.total, summary.newCount, summary.existingCount], [3, 0, 3]);
  r = await backup.importSessionZip(zipPath, "skip", freshRoot);
  assert.deepEqual(r, { imported: 0, skipped: 3, overwritten: 0 });

  // Local edit + overwrite policy restores the backup copy.
  writeFileSync(join(freshRoot, "proj-a", "s1.jsonl"), '{"type":"session","id":"LOCAL"}\n');
  r = await backup.importSessionZip(zipPath, "overwrite", freshRoot);
  assert.deepEqual(r, { imported: 0, skipped: 0, overwritten: 3 });
  assert.equal(readFileSync(join(freshRoot, "proj-a", "s1.jsonl"), "utf8"), '{"type":"session","id":"a"}\n');

  // Traversal guard unit checks (raw entry names as they appear in a zip).
  assert.equal(backup.safeRelPath("ok/z.jsonl"), "ok/z.jsonl", "plain relative path is kept");
  assert.equal(backup.safeRelPath("../evil.jsonl"), null, "parent reference rejected");
  assert.equal(backup.safeRelPath("a/../../b.jsonl"), null, "nested parent reference rejected");
  assert.equal(backup.safeRelPath("/abs.jsonl"), null, "absolute path rejected");
  assert.equal(backup.safeRelPath("C:/x/y.jsonl"), null, "drive-letter path rejected");

  // Hostile zip: JSZip normalizes ../ on write (so it lands as a plain top-level
  // file inside the root — still safe); absolute entries are refused outright.
  const evil = new JSZip();
  evil.file("../evil.jsonl", "x");
  evil.file("/abs.jsonl", "y");
  evil.file("ok/z.jsonl", '{"z":1}\n');
  writeFileSync(join(tmp, "evil.zip"), await evil.generateAsync({ type: "nodebuffer" }));
  const evilRoot = join(tmp, "evil-root");
  summary = await backup.inspectSessionBackup(join(tmp, "evil.zip"), evilRoot);
  assert.equal(summary.total, 2, "absolute entry refused; normalized + plain entries kept");
  r = await backup.importSessionZip(join(tmp, "evil.zip"), "overwrite", evilRoot);
  assert.deepEqual(r, { imported: 2, skipped: 0, overwritten: 0 });
  assert.ok(!existsSync(join(tmp, "abs.jsonl")), "/abs must not escape the sessions root");
  assert.ok(existsSync(join(evilRoot, "evil.jsonl")), "normalized entry stays inside the root");

  // Non-zip input fails with a readable error.
  writeFileSync(join(tmp, "notzip.zip"), "definitely not a zip");
  await assert.rejects(() => backup.inspectSessionBackup(join(tmp, "notzip.zip"), freshRoot), /not a readable zip/);

  console.log("test-backup: all assertions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
