import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

const bs = await import("../src/main/shell-bootstrap.ts");

/**
 * shell-bootstrap write-back tests.
 *
 * The write-back is what keeps pi itself agreeing with the shell MPI told the
 * model about: MPI's resolver knows the Git for Windows registry key, pi does
 * not, so without this a session could claim "shell: Git Bash" while pi still
 * throws `No bash shell found.` (the exact prompt-vs-runtime drift Codex and
 * Claude Code both shipped bugs for).
 */

const root = mkdtempSync(join(tmpdir(), "mpi-shell-bootstrap-"));
const settingsPath = join(root, "settings.json");
const GIT_BASH = "E:\\Git\\bin\\bash.exe";
const PS51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

/** Fake deps: a Git Bash that pi's own search would never find. */
const bashDeps = {
  platform: "win32",
  env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
  fileExists: (p) => p.toLowerCase() === GIT_BASH.toLowerCase(),
  where: () => [],
  registryGitRoot: () => "E:\\Git",
  probeVersion: () => "GNU bash, version 5.3.15(1)-release",
};

/** Fake deps: no bash anywhere → PowerShell 5.1 fallback. */
const noBashDeps = {
  platform: "win32",
  env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
  fileExists: (p) => p.toLowerCase() === PS51.toLowerCase(),
  where: () => [],
  registryGitRoot: () => null,
  probeVersion: () => "5.1.19041.6456",
};

function freshSettings(value) {
  rmSync(settingsPath, { force: true });
  if (value !== undefined) writeFileSync(settingsPath, JSON.stringify(value, null, 2), "utf8");
}

try {
  // --- 1. missing shellPath → resolved bash path is written ------------------
  freshSettings({ defaultProvider: "p", packages: ["npm:pi-web-access"] });
  {
    const state = bs.getShellState(settingsPath, { deps: bashDeps });
    assert.equal(state.shell.kind, "bash");
    assert.equal(state.configuredPath, null);
    assert.equal(state.configuredPathStale, false);

    assert.equal(bs.ensureShellPathConfigured(settingsPath, state), true, "must write shellPath");
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.shellPath, GIT_BASH);
    // Untouched keys survive the write-back.
    assert.equal(written.defaultProvider, "p");
    assert.deepEqual(written.packages, ["npm:pi-web-access"]);

    // No BOM: pi parses settings.json with a plain JSON.parse, and a leading
    // BOM makes the whole file silently fail to load.
    const bytes = readFileSync(settingsPath);
    assert.equal(bytes[0], 0x7b, "settings.json must not start with a BOM");
    ok("缺失 shellPath 时写回解析到的 Git Bash，并保留其他键、无 BOM");
  }

  // --- 2. correct shellPath already present → no rewrite ---------------------
  freshSettings({ shellPath: GIT_BASH, defaultModel: "m" });
  {
    const before = readFileSync(settingsPath, "utf8");
    const state = bs.getShellState(settingsPath, { deps: bashDeps });
    assert.equal(state.configuredPath, GIT_BASH, "a live shellPath must be reported as configured");
    assert.equal(bs.ensureShellPathConfigured(settingsPath, state), false, "must not rewrite a valid shellPath");
    assert.equal(readFileSync(settingsPath, "utf8"), before, "file must be byte-identical");
    ok("shellPath 已正确时不做任何改动");
  }

  // --- 3. stale shellPath (points at a deleted install) → repaired -----------
  freshSettings({ shellPath: "D:\\uninstalled\\bash.exe" });
  {
    const state = bs.getShellState(settingsPath, { deps: bashDeps });
    assert.equal(state.configuredPath, null);
    assert.equal(state.configuredPathStale, true, "a dangling shellPath must be flagged");
    assert.equal(bs.ensureShellPathConfigured(settingsPath, state), true);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).shellPath, GIT_BASH);
    ok("失效的 shellPath 被修复（并标记为 stale）");
  }

  // --- 4. no bash at all → PowerShell fallback, never written ---------------
  freshSettings({ defaultProvider: "p" });
  {
    const state = bs.getShellState(settingsPath, { deps: noBashDeps });
    assert.equal(state.shell.kind, "powershell");
    assert.equal(state.needsInstall, true);
    assert.equal(bs.ensureShellPathConfigured(settingsPath, state), false, "must not pin PowerShell as shellPath");
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).shellPath, undefined);
    ok("探测不到 bash 时降级 pwsh 且不写 shellPath（needsInstall=true）");
  }

  // --- 5. absent settings.json → created with just shellPath ----------------
  freshSettings(undefined);
  {
    const state = bs.getShellState(settingsPath, { deps: bashDeps });
    assert.equal(bs.ensureShellPathConfigured(settingsPath, state), true);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { shellPath: GIT_BASH });
    const bytes = readFileSync(settingsPath);
    assert.equal(bytes[0], 0x7b, "created settings.json must not start with a BOM");
    ok("settings.json 不存在时创建（仅 shellPath，无 BOM）");
  }

  // --- 6. corrupt settings.json is replaced, not propagated -----------------
  rmSync(settingsPath, { force: true });
  writeFileSync(settingsPath, "{ this is not json", "utf8");
  {
    const state = bs.getShellState(settingsPath, { deps: bashDeps });
    assert.equal(bs.ensureShellPathConfigured(settingsPath, state), true);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { shellPath: GIT_BASH });
    ok("损坏的 settings.json 被替换为可解析内容");
  }

  // --- 7. payload shape consumed by mpi-shelenv-ext -------------------------
  {
    freshSettings({}); // no shellPath → resolver reports the registry as the source
    const state = bs.getShellState(settingsPath, { deps: bashDeps });
    const info = bs.shellInfoPayload(state.shell, "E:\\proj");
    assert.equal(info.kind, "bash");
    assert.equal(info.path, GIT_BASH);
    assert.equal(info.source, "registry-git");
    assert.equal(info.cwd, "E:\\proj");
    assert.equal(typeof info.os, "string");
    assert.ok(info.os.length > 0);
    ok("MPI_SHELL_INFO 载荷字段完整（extension 侧按同名字段解析）");
  }

  assert.equal(bs.readShellPathFromSettings(settingsPath), null, "fresh settings has no shellPath yet");
  bs.ensureShellPathConfigured(settingsPath, bs.getShellState(settingsPath, { deps: bashDeps }));
  assert.equal(bs.readShellPathFromSettings(settingsPath), GIT_BASH);
  ok("readShellPathFromSettings 读取写回值");

  console.log(`\ntest-shell-bootstrap: ${passed} 组断言全部通过`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
