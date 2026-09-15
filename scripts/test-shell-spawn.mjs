import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

/**
 * Process-level smoke test for the shell wiring.
 *
 * Proves the two things a fake-API unit test cannot:
 *  1. the real pi CLI accepts the argv MPI now builds (`--exclude-tools
 *     powershell`), so the flag name/format is right;
 *  2. the shell-env extension we write into userData actually loads in pi's own
 *     transpiler (type-only import, `export default`, hook signature).
 *
 * The injected prompt TEXT is asserted in test-shell-env-ext.mjs against a fake
 * ExtensionAPI — the only way to read the assembled system prompt without
 * making a model call.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Locate a real pi CLI; skip when this machine has none (CI/fresh clones). */
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
  console.log("test-shell-spawn: SKIP (no local pi CLI found)");
  process.exit(0);
}

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

/**
 * Write the extension the same way shellenv-extension.ts does at build time:
 * the raw source of mpi-shelenv-ext.ts, verbatim.
 */
function writeShellEnvExtension(dir) {
  const source = readFileSync(join(ROOT, "src", "main", "mpi-shelenv-ext.ts"), "utf8");
  const file = join(dir, "mpi-shellev.ts");
  writeFileSync(file, source, "utf8");
  return file;
}

const work = mkdtempSync(join(tmpdir(), "mpi-shell-spawn-"));
const agentDir = join(work, "agent");
const extDir = join(work, "ext-out");
mkdirSync(extDir, { recursive: true });

let proc = null;
const cleanup = () => {
  try {
    proc?.kill();
  } catch {
    /* already gone */
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

/** Spawn pi in rpc mode with the same shell-related argv MPI produces. */
function startPi({ shellInfo, excludePowershell }) {
  const args = ["--mode", "rpc"];
  if (excludePowershell) args.push("--exclude-tools", "powershell");
  args.push("--extension", writeShellEnvExtension(extDir));
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: work,
    env: {
      ...process.env,
      // Isolate from the developer's real agent dir (packages, models, skills).
      PI_CODING_AGENT_DIR: agentDir,
      MPI_SHELL_INFO: JSON.stringify(shellInfo),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  proc = child;

  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString("utf8")));

  const response = new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`no rpc response within 60s; stderr: ${stderr.slice(-800)}`)), 60_000);
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
          continue; // non-JSON diagnostics on stdout
        }
        if (msg?.type === "response" && msg.id === "t1") {
          clearTimeout(timer);
          resolve(msg);
          return;
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`pi exited early (code=${code}); stderr: ${stderr.slice(-1200)}`));
    });
    child.on("error", reject);
  });

  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  return { child, response, send, stderr: () => stderr };
}

try {
  // --- 1. bash session: argv + extension load -------------------------------
  {
    const info = {
      kind: "bash",
      path: "E:\\MyWorkSpace\\Software\\Git\\bin\\bash.exe",
      version: "GNU bash, version 5.3.15(1)-release",
      source: "registry-git",
      cwd: work,
      os: "Windows 10 (10.0.19045) x64",
    };
    const { response, send, stderr } = startPi({ shellInfo: info, excludePowershell: true });
    send({ id: "t1", type: "get_commands" });
    const res = await response;
    assert.notEqual(res.success, false, `pi rejected the rpc command: ${JSON.stringify(res)}`);
    assert.ok(Array.isArray(res.data?.commands), "get_commands must return a command list");
    assert.ok(
      !/mpi-shellev|Failed to load extension|Cannot find module/.test(stderr()),
      `extension load must be clean; stderr: ${stderr().slice(-800)}`,
    );
    ok("真实 pi 进程：接受 --exclude-tools powershell，shell-env 扩展加载无报错");
  }

  // --- 2. powershell fallback: no tool flags, extension still loads ---------
  {
    const info = {
      kind: "powershell",
      path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      version: "7.6.5",
      source: "fallback-pwsh",
      cwd: work,
      os: "Windows 10 (10.0.19045) x64",
    };
    const { response, send, stderr } = startPi({ shellInfo: info, excludePowershell: false });
    send({ id: "t1", type: "get_commands" });
    const res = await response;
    assert.notEqual(res.success, false, `pi rejected the rpc command: ${JSON.stringify(res)}`);
    assert.ok(
      !/mpi-shellev|Failed to load extension|Cannot find module/.test(stderr()),
      `extension load must be clean; stderr: ${stderr().slice(-800)}`,
    );
    ok("真实 pi 进程：无工具白名单（保住扩展工具）时扩展同样加载成功");
  }

  console.log(`\ntest-shell-spawn: ${passed} 组断言全部通过`);
  cleanup();
  process.exit(0);
} catch (err) {
  cleanup();
  console.error("test-shell-spawn FAILED:", err?.message || err);
  process.exit(1);
}
