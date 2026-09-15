import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

/**
 * End-to-end proof that the shell write-back is load-bearing.
 *
 * `pi --mode rpc` exposes a `bash` command that runs through the SAME
 * resolution as the bash tool (`session.executeBash` → `createLocalBashOperations
 * ({ shellPath })`), so this exercises the real path without needing a model.
 *
 * The scenario mirrors a machine whose only Git lives outside pi's search path
 * (this workstation: Git installed at E:\MyWorkSpace\Software\Git, discovered by
 * MPI through the Git for Windows registry key):
 *
 *   B — PATH stripped of Git/System32 + no shellPath  → pi reports
 *       `No bash shell found.` (the pre-fix failure, per command)
 *   C — same environment + shellPath adopted by
 *       shell-bootstrap.ensureShellPathConfigured     → commands run
 *
 * B failing and C succeeding is the whole justification for the write-back.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function findPiCli() {
  const candidates = [
    process.env.MPI_TEST_PI_CLI,
    join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    join(dirname(process.execPath), "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    process.env.APPDATA
      ? join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
      : null,
  ];
  return candidates.find((p) => !!p && existsSync(p)) ?? null;
}

const cli = findPiCli();
if (!cli) {
  console.log("test-shell-e2e: SKIP (no local pi CLI found)");
  process.exit(0);
}

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

const bs = await import("../src/main/shell-bootstrap.ts");
const sr = await import("../src/main/shell-resolver.ts");

const root = mkdtempSync(join(tmpdir(), "mpi-shell-e2e-"));

/** PATH with Git, System32 and WindowsApps removed — `where bash.exe` finds nothing. */
function strippedPath() {
  const sep = process.platform === "win32" ? ";" : ":";
  const parts = (process.env.PATH || "")
    .split(sep)
    .filter(Boolean)
    .filter((p) => !/git/i.test(p) && !/system32/i.test(p) && !/windowsapps/i.test(p));
  parts.push(join(root, "empty-path")); // keep PATH non-empty
  return parts.join(sep);
}

/** Best-effort temp cleanup: a just-killed pi may still hold the cwd. */
function safeRm(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
      return;
    } catch {
      // retry
    }
  }
}

function startPi(agentDir) {
  return spawn(process.execPath, [cli, "--mode", "rpc"], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PATH: strippedPath(),
      ProgramFiles: "C:\\definitely-not-here",
      "ProgramFiles(x86)": "C:\\definitely-not-here",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function runBash(agentDir, command) {
  const child = startPi(agentDir);
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
  const done = new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`no rpc response in 60s; stderr: ${stderr.slice(-600)}`)), 60_000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.type === "response" && msg.id === "b1") {
          clearTimeout(timer);
          resolve(msg);
          return;
        }
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`pi exited before responding; stderr: ${stderr.slice(-800)}`));
    });
    child.on("error", reject);
  });
  child.stdin.write(`${JSON.stringify({ id: "b1", type: "bash", command })}\n`);
  const kill = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  return { done, kill };
}

try {
  mkdirSync(join(root, "empty-path"), { recursive: true });

  // Real Git Bash on this machine, discovered the way MPI discovers it.
  const resolved = sr.resolveShell();
  if (resolved.kind !== "bash") {
    console.log("test-shell-e2e: SKIP (no Git Bash resolvable on this machine)");
    safeRm(root);
    process.exit(0);
  }

  // --- B. no shellPath + Git hidden from PATH → pi cannot find bash ---------
  const bareAgent = join(root, "agent-bare");
  mkdirSync(bareAgent, { recursive: true });
  writeFileSync(join(bareAgent, "settings.json"), JSON.stringify({ defaultProvider: "p" }), "utf8");
  {
    const marker = "MPI_E2E_SHOULD_NOT_RUN";
    const { done, kill } = runBash(bareAgent, `echo ${marker}`);
    const res = await done;
    kill();
    await new Promise((r) => setTimeout(r, 400));
    const failed = res.success === false;
    const text = `${res.error ?? ""}${JSON.stringify(res.data ?? {})}`;
    assert.ok(failed, `expected pi to fail without a usable bash, got: ${JSON.stringify(res).slice(0, 300)}`);
    assert.ok(/bash shell found|ENOENT|not found/i.test(text), `unexpected error text: ${text.slice(0, 300)}`);
    assert.ok(!text.includes(marker), "the command must not have run");
    ok("对照组：PATH 里没有 Git、settings 里没有 shellPath → pi 报 No bash shell found（逐条命令失败）");
  }

  // --- C. same environment, but MPI's write-back adopted the registry Git ---
  const agent = join(root, "agent");
  mkdirSync(agent, { recursive: true });
  const settingsPath = join(agent, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "p" }), "utf8");
  {
    // What MPI does at spawn time / on 「重新检测」: resolve, then persist.
    const wrote = bs.ensureShellPathConfigured(settingsPath, bs.getShellState(settingsPath));
    assert.equal(wrote, true, "write-back must trigger for a registry-only Git");
    assert.equal(JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(settingsPath, "utf8"))).shellPath, resolved.path);

    const marker = "MPI_E2E_BASH_OK";
    const { done, kill } = runBash(agent, `echo ${marker} && pwd`);
    const res = await done;
    kill();
    await new Promise((r) => setTimeout(r, 400));
    assert.notEqual(res.success, false, `bash must run: ${JSON.stringify(res).slice(0, 300)}`);
    assert.equal(res.data?.exitCode, 0, `exit code: ${JSON.stringify(res.data).slice(0, 300)}`);
    assert.ok(String(res.data?.output || "").includes(marker), "command output must come back");
    ok("写回后：同样环境里命令正常执行（验证 ensureShellPathConfigured 是必需项，不是可选项）");
  }

  console.log(`\ntest-shell-e2e: ${passed} 组断言全部通过`);
  safeRm(root);
  process.exit(0);
} catch (err) {
  safeRm(root);
  console.error("test-shell-e2e FAILED:", err?.message || err);
  process.exit(1);
}
