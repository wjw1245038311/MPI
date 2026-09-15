import assert from "node:assert/strict";
import { register } from "node:module";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const sr = await import("../src/main/shell-resolver.ts");

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

/** Build deps over a normalized (case-insensitive, separator-agnostic) fake FS. */
function deps({ files = [], where = {}, gitRoot = null, probe = () => null, env = {} } = {}) {
  const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
  const existing = new Set(files.map(norm));
  return {
    platform: "win32",
    env: {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      SystemRoot: "C:\\Windows",
      ...env,
    },
    fileExists: (p) => existing.has(norm(p)),
    where: (exe) => where[exe.toLowerCase()] ?? [],
    registryGitRoot: () => gitRoot,
    probeVersion: probe,
  };
}

const resolve = (options) => sr.resolveShell(options);

// --- candidate path helpers ---------------------------------------------------
{
  assert.equal(sr.isWslBashPath("C:\\Windows\\System32\\bash.exe"), true);
  assert.equal(sr.isWslBashPath("c:/windows/sysnative/bash.exe"), true);
  assert.equal(sr.isWslBashPath("C:\\Program Files\\Git\\bin\\bash.exe"), false);
  assert.equal(sr.isStoreAliasBashPath("C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe"), true);
  assert.equal(sr.isStoreAliasBashPath("C:\\Program Files\\Git\\usr\\bin\\bash.exe"), false);
  ok("WSL 启动器与 Store 别名的识别（大小写/斜杠不敏感）");
}

// --- 1. explicit shellPath wins (Claude Code's CLAUDE_CODE_GIT_BASH_PATH) -----
{
  const shellPath = "D:\\Tools\\git\\bin\\bash.exe";
  const shell = resolve({
    settingsShellPath: shellPath,
    deps: deps({
      files: [shellPath, join("C:\\Program Files", "Git", "bin", "bash.exe")],
      probe: () => "GNU bash, version 5.2.37(1)-release",
    }),
  });
  assert.equal(shell.kind, "bash");
  assert.equal(shell.source, "settings");
  assert.equal(shell.path, shellPath);
  assert.equal(shell.version, "GNU bash, version 5.2.37(1)-release");
  ok("settings.shellPath 命中优先，且 version 被记录");
}

// --- 2. registry-discovered Git outside the default install location ----------
{
  const root = "E:\\MyWorkSpace\\Software\\Git";
  const bin = join(root, "bin", "bash.exe");
  const shell = resolve({ deps: deps({ files: [bin], gitRoot: root }) });
  assert.equal(shell.kind, "bash");
  assert.equal(shell.source, "registry-git");
  assert.equal(shell.path, bin);
  ok("注册表 InstallPath 覆盖非默认安装目录（本机 E:\\MyWorkSpace\\Software\\Git 场景）");
}

// --- 3. registry root falls back to usr\\bin when bin\\bash.exe is absent -----
{
  const root = "E:\\Git";
  const usrBin = join(root, "usr", "bin", "bash.exe");
  const shell = resolve({ deps: deps({ files: [usrBin], gitRoot: root }) });
  assert.equal(shell.source, "registry-git");
  assert.equal(shell.path, usrBin);
  ok("Git 根下 bin\\bash.exe 缺失时回退 usr\\bin\\bash.exe");
}

// --- 4. stale shellPath is not trusted ---------------------------------------
{
  const shell = resolve({
    settingsShellPath: "D:\\gone\\bash.exe",
    deps: deps({
      files: [join("C:\\Program Files", "Git", "bin", "bash.exe")],
    }),
  });
  assert.equal(shell.source, "program-files", "a shellPath that no longer exists must not win");
  ok("失效的 shellPath 不影响后续探测（不静默采用坏路径）");
}

// --- 5. `where bash.exe` — WSL + Store alias must be rejected -----------------
{
  const gitBash = "E:\\MyWorkSpace\\Software\\Git\\usr\\bin\\bash.exe";
  const shell = resolve({
    deps: deps({
      files: [gitBash],
      where: {
        "bash.exe": [
          "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
          "E:\\MyWorkSpace\\Software\\Git\\usr\\bin\\bash.exe",
          "C:\\Windows\\System32\\bash.exe",
        ],
      },
    }),
  });
  assert.equal(shell.kind, "bash");
  assert.equal(shell.source, "path");
  assert.equal(shell.path, gitBash, "must skip the Store alias and the WSL launcher");
  ok("where bash.exe 结果中剔除 Store 别名与 WSL 启动器（Codex #40328 同款坑）");
}

// --- 6. only WSL/Store bash available → PowerShell fallback, reported --------
{
  const shell = resolve({
    deps: deps({
      where: { "bash.exe": ["C:\\Windows\\System32\\bash.exe"] },
      files: [join("C:\\Program Files", "PowerShell", "7", "pwsh.exe")],
      probe: () => "7.6.5",
    }),
  });
  assert.equal(shell.kind, "powershell");
  assert.equal(shell.source, "fallback-pwsh");
  assert.equal(shell.version, "7.6.5");
  assert.equal(sr.needsBashInstall(shell), true);
  ok("只有 WSL/Store bash 时降级到 pwsh（不是静默用 WSL 跑 Linux 命令）");
}

// --- 7. pwsh discovery prefers the real install over PATH/WindowsApps ---------
{
  const real = join("C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  const alias = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe";
  const shell = resolve({
    deps: deps({ files: [real, alias], where: { "pwsh.exe": [alias] } }),
  });
  assert.equal(shell.kind, "powershell");
  assert.equal(shell.source, "fallback-pwsh");
  assert.equal(shell.path, real);
  ok("pwsh 优先取 %ProgramFiles%\\PowerShell\\7，其次才是 PATH 上的 MSIX 别名");
}

// --- 8. Windows PowerShell 5.1 as the last resort ----------------------------
{
  const legacy = join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const shell = resolve({ deps: deps({ files: [legacy] }) });
  assert.equal(shell.kind, "powershell");
  assert.equal(shell.source, "fallback-powershell");
  assert.equal(shell.path, legacy);
  assert.equal(sr.needsBashInstall(shell), true);
  ok("完全没有 bash 时给出 Windows PowerShell 5.1 兜底，并标记 needsBashInstall");
}

// --- 9. nothing at all → still a reportable value, never a throw --------------
{
  const shell = resolve({ deps: deps() });
  assert.equal(shell.kind, "powershell");
  assert.equal(sr.needsBashInstall(shell), true);
  ok("什么都没探测到也不抛异常（由调用方引导安装，而不是让每条命令报错）");
}

// --- 10. spawn flags keep exactly one shell available ------------------------
{
  const bash = resolve({ deps: deps({ files: [join("C:\\Program Files", "Git", "bin", "bash.exe")] }) });
  assert.deepEqual(sr.shellToolFlags(bash), { excludeTools: ["powershell"] });
  const ps = resolve({ deps: deps({ files: [join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")] }) });
  assert.deepEqual(sr.shellToolFlags(ps), {}, "PS 路径不得传 --tools（会连带禁用扩展工具）");
  assert.equal(sr.needsBashInstall(bash), false);
  ok("工具开关：bash 用 --exclude-tools powershell，PS 路径不传工具白名单");
}

console.log(`\ntest-shell-resolver: ${passed} 组断言全部通过`);
