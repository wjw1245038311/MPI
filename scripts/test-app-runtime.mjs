/** App runtime tests — the manifest-v2 service layer:
 *  - pure helpers (path/entry resolution, module normalization, host guards)
 *  - activate/deactivate orchestration with an injected fake RuntimeDeps
 *  - rolling log behaviour against a temp dir
 *
 * app-runtime.ts pulls in app-store-core.ts (dependency-free) and node builtins
 * only, so it loads in plain node with no electron stub. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Source files use extensionless relative imports (bundler style); the loader
// retries those with a .ts suffix so this test can import them in plain node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
function ok(name) {
  passed++;
  console.log(`PASS ${name}`);
}

const rt = await import("../src/main/app-runtime.ts");

/* ------------------------- path + module helpers ------------------------- */

assert.equal(typeof rt.resolveServiceEntry("/apps/x", "service/index.cjs"), "string");
assert.equal(rt.resolveServiceEntry("/apps/x", "../evil.js"), null);
assert.equal(rt.resolveServiceEntry("/apps/x", "C:\\evil.js"), null);
assert.equal(rt.resolveServiceEntry("/apps/x", "/abs/evil.js"), null);
ok("resolveServiceEntry: keeps entry inside the app dir, rejects traversal/absolute");

const esmMod = rt.normalizeServiceModule({ activate: async () => ({}) });
assert.equal(typeof esmMod.activate, "function");
const cjsMod = rt.normalizeServiceModule({ default: { activate: async () => ({}) } });
assert.equal(typeof cjsMod.activate, "function");
const onlyDeactivate = rt.normalizeServiceModule({ deactivate: async () => {} });
assert.equal(typeof onlyDeactivate.deactivate, "function");
assert.deepEqual(rt.normalizeServiceModule({}), {});
ok("normalizeServiceModule: handles ESM/CJS/default and empty namespaces");

/* ------------------------- host capability guard ------------------------- */

function makeHarness(manifest, opts = {}) {
  const statuses = [];
  const logs = [];
  const processes = new Set();
  const killed = [];
  const spawnCalls = [];
  const deps = {
    loadModule: opts.loadModule || (async () => ({ activate: async () => ({ voice: { sttModel: "x" } }) })),
    spawnProcess: (_c, _a, _cwd, _env, _shell, _onOutput) => {
      spawnCalls.push({ command: _c, args: _a, cwd: _cwd, env: _env, shell: _shell, onOutput: _onOutput });
      return 4242;
    },
    killProcess: (pid) => killed.push(pid),
    now: () => "2026-09-13T00:00:00.000Z",
  };
  return {
    statuses,
    logs,
    processes,
    killed,
    spawnCalls,
    deps,
    opts: {
      manifest,
      dir: opts.dir || "/apps/x",
      dataDir: opts.dataDir || join(tmpdir(), "mpi-app-rt-test"),
      userData: "/userdata",
      fieldValues: { baseUrl: "http://127.0.0.1:8820/v1" },
      processes,
      deps,
      setStatus: (s) => statuses.push(s),
      log: (l) => logs.push(l),
    },
  };
}

const noCap = makeHarness({ id: "x", version: "1", capabilities: [] });
const h1 = rt.createAppHost(noCap.opts);
assert.equal(h1.spawn("echo", ["hi"]), null);
assert.ok(noCap.logs.some((l) => l.includes("spawn denied")), "spawn without capability must be denied + logged");
assert.equal(noCap.processes.size, 0);

const withCap = makeHarness({ id: "x", version: "1", capabilities: ["process"] });
const h2 = rt.createAppHost(withCap.opts);
assert.equal(h2.spawn("echo", ["hi"]), 4242);
assert.equal(withCap.processes.size, 1);
assert.equal(typeof h2.execPath, "string");
assert.ok(h2.execPath.length > 0, "execPath must be exposed");
assert.equal(h2.execPath, process.execPath);
// spawn merges extra env over process.env and resolves cwd relative to the app dir
assert.equal(h2.spawn("echo", ["hi"], { env: { MPI_APP_TEST: "1" } }), 4242);
const call = withCap.spawnCalls.at(-1);
assert.equal(call.env.MPI_APP_TEST, "1");
assert.ok(call.env.PATH || call.env.Path, "process.env is preserved");
assert.equal(call.cwd, "/apps/x");
assert.equal(h2.spawn("echo", ["hi"], { cwd: "sub" }), 4242);
assert.equal(withCap.spawnCalls.at(-1).cwd, join("/apps/x", "sub"));
assert.equal(h2.spawn("echo", ["hi"], { shell: false }), 4242);
assert.equal(withCap.spawnCalls.at(-1).shell, false, "explicit shell:false is forwarded");
assert.equal(h2.spawn("echo", ["hi"]), 4242);
assert.equal(withCap.spawnCalls.at(-1).shell, undefined, "shell defaults to the runtime's value");
// the child's output is forwarded to the app log (so a crashed server is diagnosable)
assert.equal(typeof withCap.spawnCalls.at(-1).onOutput, "function", "spawn passes an output forwarder");
withCap.spawnCalls.at(-1).onOutput("load error: onnxruntime.dll not found");
assert.ok(
  withCap.logs.some((l) => l.includes("[child] load error: onnxruntime.dll not found")),
  "child output is appended to the app log",
);
h2.status("starting");
assert.equal(withCap.statuses.at(-1).state, "starting");
assert.deepEqual(h2.getFieldValues(), { baseUrl: "http://127.0.0.1:8820/v1" });
ok("createAppHost: spawn gated by capability, execPath/env/cwd exposed");

/* ------------------------- activate / deactivate ------------------------- */

// success: returns voice patch + status ready
const good = makeHarness({ id: "x", version: "1", service: { entry: "service/index.cjs" } }, { dir: process.cwd() });
// point dir at repo so the entry file exists
const goodDir = join(ROOT, "src", "main");
good.opts.dir = goodDir;
// loader is faked, but activateService checks the entry file exists — use a real file
good.opts.manifest.service.entry = "app-store-core.ts";
const r1 = await rt.activateService(good.opts);
assert.equal(r1.ok, true, `activate should succeed: ${r1.error || ""}`);
assert.deepEqual(r1.voice, { sttModel: "x" });
assert.equal(good.statuses[0].state, "starting");
assert.equal(good.statuses.at(-1).state, "ready");
ok("activateService: injects host, returns voice patch, reports ready");

// failure: module throws → ok:false, status error, no crash
const bad = makeHarness(
  { id: "x", version: "1", service: { entry: "app-store-core.ts" } },
  {
    dir: goodDir,
    loadModule: async () => ({
      activate: async () => {
        throw new Error("boom");
      },
    }),
  },
);
const r2 = await rt.activateService(bad.opts);
assert.equal(r2.ok, false);
assert.equal(r2.error, "boom");
assert.equal(bad.statuses.at(-1).state, "error");
assert.ok(bad.logs.some((l) => l.includes("activate failed")));
ok("activateService: module errors are contained and reported as status=error");

// missing entry → error before loading
const missing = makeHarness({ id: "x", version: "1", service: { entry: "service/nope.cjs" } }, { dir: goodDir });
const r3 = await rt.activateService(missing.opts);
assert.equal(r3.ok, false);
assert.match(r3.error, /not found/);
assert.equal(missing.statuses.at(-1).state, "error");
ok("activateService: missing entry reported without loading");

// no service spec → no-op success
const noService = makeHarness({ id: "x", version: "1" }, { dir: goodDir });
const r4 = await rt.activateService(noService.opts);
assert.equal(r4.ok, true);
assert.equal(noService.statuses.length, 0);
ok("activateService: manifest without service is a no-op");

// deactivate: runs hook + reaps processes
const off = makeHarness({ id: "x", version: "1", service: { entry: "app-store-core.ts" } }, { dir: goodDir });
off.processes.add(111);
off.processes.add(222);
await rt.deactivateService(off.opts);
assert.deepEqual(off.killed.sort((a, b) => a - b), [111, 222]);
assert.equal(off.processes.size, 0);
assert.equal(off.statuses.at(-1).state, "stopped");
ok("deactivateService: reaps managed processes and reports stopped");

/* ------------------------- rolling log ------------------------- */

const appsRoot = mkdtempSync(join(tmpdir(), "mpi-app-log-"));
try {
  for (let i = 0; i < rt.LOG_TAIL + 25; i++) rt.appendAppLog(appsRoot, "demo", `line-${i}`);
  const lines = rt.readAppLog(appsRoot, "demo");
  assert.equal(lines.length, rt.LOG_TAIL, "log must be capped at LOG_TAIL");
  assert.equal(lines.at(-1), `line-${rt.LOG_TAIL + 24}`);
  assert.equal(lines[0], "line-25");
  assert.deepEqual(rt.readAppLog(appsRoot, "nope"), []);
  ok("appendAppLog/readAppLog: rolling tail is capped");
} finally {
  rmSync(appsRoot, { recursive: true, force: true });
}

console.log(`\napp-runtime: all ${passed} checks passed`);
