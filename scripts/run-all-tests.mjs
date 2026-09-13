#!/usr/bin/env node
/**
 * MPI L1 聚合测试运行器（test pyramid 的"快环"入口）。
 *
 * 用法：
 *   npm test                          # 顺序跑全部 scripts/test-*.mjs
 *   npm test -- permission choice     # 只跑名字包含过滤词的测试
 *   node scripts/run-all-tests.mjs --list
 *
 * 约定（见 docs/E2E-TESTING.md）：
 *  - 每个测试文件 = scripts/test-<name>.mjs，独立进程、无共享状态
 *  - 命令优先取 package.json 里对应的 "test:<name>" script（保证 flags 一致），
 *    找不到时回退 `node --experimental-strip-types scripts/<file>`
 *  - test-tui-race.cjs 需要先生成 bundle，不纳入自动发现（npm run test:tuirace）
 *  - 任一测试失败/超时 → 退出码非零（CI gate）
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(ROOT, "scripts");
const TIMEOUT_MS = Number(process.env.MPI_TEST_TIMEOUT_MS || 180_000);

// 需要额外前置步骤（bundle）或依赖交互的测试，不纳入自动发现。
const EXCLUDE = new Set(["test-tui-race"]);

// 环境相关测试：前置条件缺失时 SKIP（不算失败）。返回 null = 可运行，否则为跳过原因。
function skipReason(name) {
  if (name === "remote-protocol") {
    const kt = join(ROOT, "android/app/src/main/java/com/mpi/remote/RemoteProtocol.kt");
    return existsSync(kt) ? null : "android tree not present locally";
  }
  // 交互式 PTY 诊断（需显式参数 / 特定全局 pi CLI 安装位置），只手动跑
  if (name === "tui-spawn") return "manual dev diagnostic (needs global pi CLI at AppData/Roaming/npm)";
  if (name === "tui-resume") return "manual dev diagnostic (needs explicit <session.jsonl> arg)";
  // 本地语音示例包端到端测试依赖开发用 sherpa 运行时+模型（tmp/sherpa-spike）
  if (name === "local-voice") {
    const spike = join(ROOT, "tmp", "sherpa-spike");
    const modelDir = join(spike, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09");
    const ready =
      existsSync(join(spike, "node_modules", "sherpa-onnx-node")) &&
      existsSync(join(modelDir, "model.int8.onnx")) &&
      existsSync(join(modelDir, "tokens.txt"));
    return ready ? null : "sherpa spike artifacts not present (tmp/sherpa-spike)";
  }
  return null;
}

function discover() {
  const files = readdirSync(SCRIPTS_DIR)
    .filter((f) => /^test-.+\.mjs$/.test(f))
    .sort();
  return files.map((file) => ({
    file,
    name: file.replace(/^test-/, "").replace(/\.mjs$/, ""),
  })).filter((t) => !EXCLUDE.has(t.file));
}

function commandFor(test, pkgScripts) {
  const npmCmd = pkgScripts[`test:${test.name}`];
  if (npmCmd && typeof npmCmd === "string") return npmCmd;
  return `node --experimental-strip-types scripts/${test.file}`;
}

function runOne(cmd) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let out = "";
    const child = spawn(cmd, { cwd: ROOT, shell: true, windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill(true); } catch { /* already gone */ }
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { out += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); resolvePromise({ ok: false, timedOut: false, ms: Date.now() - started, output: `spawn error: ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code === null && out.length === 0) return resolvePromise({ ok: false, timedOut: true, ms, output: "(no output)" });
      resolvePromise({ ok: code === 0, timedOut: false, ms, output: out.trim() });
    });
  });
}

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const t of discover()) console.log(t.name);
  process.exit(0);
}
const filters = args.filter((a) => !a.startsWith("-"));

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const tests = discover().filter((t) => filters.every((f) => t.name.includes(f)));

if (tests.length === 0) {
  console.error(`no tests matched ${JSON.stringify(filters)}; use --list to see available names`);
  process.exit(2);
}

console.log(`MPI L1 test run: ${tests.length} test(s), timeout ${TIMEOUT_MS / 1000}s each\n`);
const results = [];
for (const t of tests) {
  const skip = skipReason(t.name);
  if (skip) {
    results.push({ name: t.name, ok: true, skipped: true, ms: 0 });
    console.log(`⊘ ${t.name} … SKIP (${skip})`);
    continue;
  }
  const cmd = commandFor(t, pkg.scripts || {});
  process.stdout.write(`▶ ${t.name} … `);
  const r = await runOne(cmd);
  results.push({ name: t.name, ...r });
  console.log(`${r.ok ? "PASS" : r.timedOut ? "TIMEOUT" : "FAIL"} (${(r.ms / 1000).toFixed(1)}s)`);
  if (!r.ok) {
    const tail = r.output.length > 4000 ? `…\n${r.output.slice(-4000)}` : r.output;
    console.log(`\n--- ${t.name} output (tail) ---\n${tail}\n-----------------------------`);
  }
}

const passed = results.filter((r) => r.ok && !r.skipped).length;
const skipped = results.filter((r) => r.skipped).length;
const failed = results.length - passed - skipped;
console.log(`\n==== MPI L1 summary: ${passed} passed, ${skipped} skipped, ${failed} failed (of ${results.length}) ====`);
for (const r of results) {
  if (!r.ok && !r.skipped) console.log(`  ✗ ${r.name}${r.timedOut ? " (timeout)" : ""}`);
}
process.exit(failed > 0 ? 1 : 0);
