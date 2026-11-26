import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const mod = await import("../src/main/mpi-shelenv-ext.ts");
const mpiShellEnv = mod.default;

const ENV_KEY = "MPI_SHELL_INFO";

/** Minimal fake of pi's ExtensionAPI: capture the before_agent_start handler
 * plus an optional record of setActiveTools calls. */
function harness({ activeTools = null } = {}) {
  let handler = null;
  const calls = [];
  let current = activeTools ? [...activeTools] : null;
  const pi = {
    on(event, fn) {
      if (event === "before_agent_start") handler = fn;
    },
  };
  if (current) {
    pi.getActiveTools = () => [...current];
    pi.setActiveTools = (names) => {
      calls.push([...names]);
      current = [...names];
    };
  }
  mpiShellEnv(pi);
  assert.ok(handler, "extension must register a before_agent_start handler");
  return { handler, calls, active: () => current };
}

const BASE_PROMPT = "You are an expert coding assistant operating inside pi.";
const event = (systemPrompt = BASE_PROMPT) => ({ type: "before_agent_start", prompt: "hi", systemPrompt });

function withEnv(value, fn) {
  const prev = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  }
}

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

const { handler } = harness();

// --- bash session: environment block echoes the spawned path verbatim --------
{
  const info = {
    kind: "bash",
    path: "E:\\MyWorkspace\\Software\\Git\\bin\\bash.exe",
    version: "GNU bash, version 5.2.37(1)-release",
    source: "settings",
    cwd: "E:\\MyWorkspace\\Code\\MPI",
    os: "Windows 11 (10.0.26200) x64",
  };
  const out = withEnv(JSON.stringify(info), () => handler(event(), {}));
  assert.ok(out && typeof out.systemPrompt === "string", "bash session must return a systemPrompt");
  const p = out.systemPrompt;
  assert.ok(p.startsWith(BASE_PROMPT), "base prompt must be preserved");
  assert.ok(p.includes("<environment_context>"), "must include environment_context marker");
  assert.ok(p.includes("</environment_context>"));
  // Single source of truth: the path is echoed, not re-derived.
  assert.ok(p.includes("shell_path: E:\\MyWorkspace\\Software\\Git\\bin\\bash.exe"), "shell_path echoed verbatim");
  assert.ok(p.includes("shell: Git Bash (POSIX bash)"));
  assert.ok(p.includes("os: Windows 11 (10.0.26200) x64"));
  assert.ok(p.includes("cwd: E:\\MyWorkspace\\Code\\MPI"));
  assert.ok(p.includes("shell_source: settings"));
  // Policy: the observed failure mode (PowerShell cmdlets inside bash) is banned.
  assert.ok(/禁止调用 powershell/.test(p), "bash policy must forbid powershell");
  assert.ok(p.includes("POSIX 形式"), "bash policy must explain POSIX paths");
  assert.ok(!p.includes("-LiteralPath"), "bash session must not get the PowerShell policy");
  ok("bash 会话：注入 environment_context + Git Bash policy，shell_path 与输入一致");
}

// --- 路径示例跟着本机盘符走（设备字面量泄漏审计，minibox 2026-11-26）------
// 上面那个用例的 cwd 恰好也是 E:，测不出「写死盘符」这个 bug；这里用另一个
// 盘符（maxbox 的数据在 I:）才能区分「动态生成」与「硬编码」。
{
  const info = {
    kind: "bash",
    path: "I:\\MyWorkspace\\Software\\Git\\bin\\bash.exe",
    cwd: "I:\\MyWorkspace\\Project\\App",
  };
  const p = withEnv(JSON.stringify(info), () => handler(event(), {})).systemPrompt;
  assert.ok(p.includes("本机盘符 I: 对应挂载点 /i"), "示例必须用本机盘符 I:，不是别机的字母");
  assert.ok(p.includes("`I:\\dir\\file` → `/i/dir/file`"), "POSIX 对照必须是 I: → /i");
  assert.ok(p.includes("cd /i/..."), "cd 示例也要跟着本机盘符");
  // 关键反向断言：不能残留其它设备的盘符字面量
  assert.ok(!/`E:\\dir\\file`/.test(p), "I: 机器的提示词里不得出现 E: 示例");
  assert.ok(!p.includes("/e/a/b"), "不得残留写死的 /e/ 挂载点");
  ok("bash 策略的路径示例按本机 cwd 生成，不残留他机盘符");
}

// --- 拿不到 cwd 时退化为「不举具体字母」，而不是回落到某个写死的盘符 ------
{
  const info = { kind: "bash", path: "C:\\Program Files\\Git\\bin\\bash.exe" };
  const p = withEnv(JSON.stringify(info), () => handler(event(), {})).systemPrompt;
  assert.ok(p.includes("POSIX 形式"), "仍然要讲 POSIX 路径这件事");
  assert.ok(p.includes("X:"), "无盘符时用占位字母而不是真实盘符");
  assert.ok(!/`E:|`C:|`I:/.test(p), "没有 cwd 时不能凭空举一个真实盘符");
  ok("无 cwd 时退化为中性写法，不回落到写死的盘符");
}

// --- powershell fallback session（路径提示同样跟本机盘符）-------------------
{
  const info = {
    kind: "powershell",
    path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    version: "7.6.5",
    source: "fallback-pwsh",
  };
  const out = withEnv(JSON.stringify(info), () => handler(event(), {}));
  const p = out.systemPrompt;
  assert.ok(p.includes("shell: PowerShell (7.6.5)"), "pwsh version surfaced");
  assert.ok(p.includes("shell_path: C:\\Program Files\\PowerShell\\7\\pwsh.exe"));
  assert.ok(/没有可用的 bash/.test(p), "PS policy must state bash is unavailable");
  assert.ok(p.includes("-LiteralPath"), "PS policy must follow Codex's -LiteralPath guidance");
  assert.ok(/-EncodedCommand/.test(p), "PS policy must ban -EncodedCommand");
  assert.ok(!/唯一 shell 是 Git Bash/.test(p), "PS session must not get the bash policy");
  ok("零 bash 会话：注入 PowerShell policy（-LiteralPath / 禁 iex / 禁跨 shell 拼接）");
}

// --- robustness: no / malformed / partial info must not decorate the prompt ---
{
  const noEnv = withEnv(undefined, () => handler(event(), {}));
  assert.equal(noEnv, undefined, "no MPI_SHELL_INFO → leave prompt untouched");

  const badJson = withEnv("{not json", () => handler(event(), {}));
  assert.equal(badJson, undefined, "malformed JSON → leave prompt untouched");

  const missingPath = withEnv(JSON.stringify({ kind: "bash" }), () => handler(event(), {}));
  assert.equal(missingPath, undefined, "missing path → leave prompt untouched");

  const unknownKind = withEnv(JSON.stringify({ kind: "zsh", path: "/bin/zsh" }), () => handler(event(), {}));
  assert.equal(unknownKind, undefined, "unknown kind → leave prompt untouched");
  ok("健壮性：缺失/畸形/不完整的环境信息一律不改提示词");
}

// --- idempotent: an already-decorated prompt is returned untouched -----------
{
  const info = { kind: "bash", path: "/usr/bin/bash" };
  const first = withEnv(JSON.stringify(info), () => handler(event(), {}));
  const second = withEnv(JSON.stringify(info), () => handler(event(first.systemPrompt), {}));
  assert.equal(second, undefined, "already-decorated prompt must not be decorated twice");
  ok("幂等：已含 environment_context 的提示词不再注入");
}

// --- tool reconciliation: PowerShell fallback swaps bash → powershell -------
{
  const info = { kind: "powershell", path: "C:\\pwsh.exe", source: "fallback-pwsh" };
  const h = harness({ activeTools: ["read", "bash", "edit", "write", "mpi_todo_add", "mpi_request_mode_switch"] });
  withEnv(JSON.stringify(info), () => h.handler(event(), {}));
  assert.equal(h.calls.length, 1, "must call setActiveTools exactly once");
  const next = h.active();
  assert.ok(!next.includes("bash"), "bash must be hidden when it cannot run");
  assert.ok(next.includes("powershell"), "powershell must be enabled");
  // The whole reason we avoid `--tools`: extension tools must survive.
  assert.ok(next.includes("mpi_todo_add") && next.includes("mpi_request_mode_switch"), "extension tools preserved");
  assert.ok(next.includes("read") && next.includes("edit") && next.includes("write"));
  ok("零 bash 会话：用 setActiveTools 换上 powershell 且保住扩展工具");
}

// --- tool reconciliation is inert when the set already matches ----------------
{
  const info = { kind: "powershell", path: "C:\\pwsh.exe" };
  const h = harness({ activeTools: ["read", "powershell", "edit", "write"] });
  withEnv(JSON.stringify(info), () => h.handler(event(), {}));
  assert.equal(h.calls.length, 0, "no churn when the tool set is already correct");
  ok("工具集已正确时不产生多余 setActiveTools 调用");
}

// --- bash session cleans up a stray powershell entry -------------------------
{
  const info = { kind: "bash", path: "E:\\Git\\bin\\bash.exe" };
  const h = harness({ activeTools: ["read", "bash", "powershell", "edit", "write"] });
  withEnv(JSON.stringify(info), () => h.handler(event(), {}));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.active(), ["read", "bash", "edit", "write"]);
  ok("bash 会话移除被误开启的 powershell 工具");
}

// --- older pi runtime without setActiveTools must not break -------------------
{
  const info = { kind: "powershell", path: "C:\\pwsh.exe" };
  const h = harness(); // no getActiveTools/setActiveTools
  const out = withEnv(JSON.stringify(info), () => h.handler(event(), {}));
  assert.ok(out?.systemPrompt.includes("<environment_context>"), "prompt injection still works");
  ok("特性缺失（旧 pi）时跳过工具切换，提示词照常注入");
}

console.log(`\ntest-shell-env-ext: ${passed} 组断言全部通过`);
