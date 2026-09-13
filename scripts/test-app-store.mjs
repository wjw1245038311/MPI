/** App Store tests — layered:
 * 1) pure core logic (manifest validation / template rendering / restore plan),
 * 2) install-from-directory lifecycle with `electron` stubbed,
 * 3) install-from-zip (real zip archives) + security checks,
 * 4) service-module lifecycle (activate/deactivate/autostart/restart/extensions).
 *
 * Fixtures are created in temp dirs so the tests do not depend on any shipped app.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
function ok(name) {
  passed++;
  console.log(`PASS ${name}`);
}

/** A declarative voice fixture manifest (id substituted per test). */
function manifestFor(id, over = {}) {
  return {
    id,
    name: { zh: "夹具应用", en: "Fixture app" },
    version: "1.0.0",
    category: "voice",
    description: { zh: "测试", en: "test" },
    config: {
      fields: [
        { key: "baseUrl", type: "url", label: { zh: "地址", en: "URL" }, default: "http://127.0.0.1:8800/v1" },
        { key: "model", type: "text", label: { zh: "模型", en: "Model" }, default: "SenseVoiceSmall" },
        { key: "apiKey", type: "password", label: { zh: "密钥", en: "Key" }, default: "" },
      ],
    },
    integrations: {
      voiceStt: { sttBackend: "openai", sttBaseUrl: "{{baseUrl}}", sttModel: "{{model}}", sttApiKey: "{{apiKey}}" },
    },
    ...over,
  };
}

function writeApp(dir, manifest, files = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mpi-app.json"), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

async function makeZip(file, files, opts = {}) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: opts.compression || "DEFLATE" }));
}

/* ------------------------- part 1: pure core ------------------------- */
const core = await import("../src/main/app-store-core.ts");
const manifestRaw = manifestFor("fixture-app");

const v = core.validateAppManifest(manifestRaw);
assert.equal(v.ok, true, `expected valid manifest, got ${v.ok ? "" : v.errors.join("; ")}`);
const manifest = v.manifest;
ok("validate: fixture manifest is valid");

assert.equal(core.validateAppManifest(null).ok, false);
assert.equal(core.validateAppManifest({ ...manifestRaw, id: "Bad_ID" }).ok, false);
assert.equal(core.validateAppManifest({ ...manifestRaw, name: { zh: "" } }).ok, false);
const noFields = core.validateAppManifest({ ...manifestRaw, config: { fields: [] } });
assert.equal(noFields.ok, false);
assert.match(noFields.errors.join(" "), /config\.fields/);
const badPlaceholder = core.validateAppManifest({
  ...manifestRaw,
  integrations: { voiceStt: { sttBackend: "openai", sttBaseUrl: "{{nope}}" } },
});
assert.equal(badPlaceholder.ok, false);
assert.match(badPlaceholder.errors.join(" "), /unknown field \{\{nope\}\}/);
const badSelect = core.validateAppManifest({ ...manifestRaw, config: { fields: [{ key: "x", label: { zh: "X" }, type: "select" }] } });
assert.equal(badSelect.ok, false);
ok("validate: malformed manifests rejected with reasons");

assert.equal(core.isSafeAppRelPath("service/index.cjs"), true);
assert.equal(core.isSafeAppRelPath("pi\\ext.ts"), true);
for (const bad of ["C:\\win\\x.js", "/abs/x.js", "../x.js", "a/../../x.js", "~/x.js", "a\0b.js", ""]) {
  assert.equal(core.isSafeAppRelPath(bad), false, `expected unsafe: ${JSON.stringify(bad)}`);
}
ok("core: isSafeAppRelPath rejects absolute/traversal/NUL paths");

const withService = core.validateAppManifest({
  ...manifestRaw,
  service: { entry: "service/index.cjs", autostart: false, startCommandField: "baseUrl" },
});
assert.equal(withService.ok, true, withService.ok ? "" : withService.errors.join("; "));
assert.deepEqual(withService.manifest.service, { entry: "service/index.cjs", autostart: false, startCommandField: "baseUrl" });
assert.equal(core.validateAppManifest({ ...manifestRaw, service: { entry: "../evil.js" } }).ok, false);
const absEntry = core.validateAppManifest({ ...manifestRaw, service: { entry: "C:\\evil.js" } });
assert.equal(absEntry.ok, false);
assert.match(absEntry.errors.join(" "), /relative path inside the app/);
assert.equal(core.validateAppManifest({ ...manifestRaw, service: { entry: "service/run.exe" } }).ok, false);
const badCmdField = core.validateAppManifest({ ...manifestRaw, service: { entry: "s.js", startCommandField: "nope" } });
assert.equal(badCmdField.ok, false);
assert.match(badCmdField.errors.join(" "), /startCommandField/);
ok("service: entry path/extension and startCommandField validated");

const withPi = core.validateAppManifest({ ...manifestRaw, pi: { extensions: ["pi/ext.ts", "pi/extra.js"] } });
assert.equal(withPi.ok, true, withPi.ok ? "" : withPi.errors.join("; "));
assert.deepEqual(withPi.manifest.pi, { extensions: ["pi/ext.ts", "pi/extra.js"] });
assert.equal(core.validateAppManifest({ ...manifestRaw, pi: { extensions: ["/abs/ext.ts"] } }).ok, false);
assert.equal(core.validateAppManifest({ ...manifestRaw, pi: { extensions: ["pi/ext.exe"] } }).ok, false);
assert.equal(core.validateAppManifest({ ...manifestRaw, pi: { extensions: [] } }).ok, false);
ok("pi: extension paths and extensions validated");

const withCaps = core.validateAppManifest({ ...manifestRaw, capabilities: ["process", "network", "process"] });
assert.equal(withCaps.ok, true);
assert.deepEqual(withCaps.manifest.capabilities, ["process", "network"]);
assert.equal(core.validateAppManifest({ ...manifestRaw, capabilities: ["root"] }).ok, false);
ok("capabilities: whitelisted and de-duplicated");

const v1Raw = JSON.parse(JSON.stringify(manifestRaw));
delete v1Raw.service;
delete v1Raw.pi;
delete v1Raw.capabilities;
const v1 = core.validateAppManifest(v1Raw);
assert.equal(v1.ok, true);
assert.equal(v1.manifest.service, undefined);
assert.equal(v1.manifest.pi, undefined);
ok("v1 manifest remains valid (backward compatible)");

const values = core.defaultFieldValues(manifest);
assert.deepEqual(values, { baseUrl: "http://127.0.0.1:8800/v1", model: "SenseVoiceSmall", apiKey: "" });
let patch = core.renderVoicePatch(manifest.integrations?.voiceStt, values);
assert.equal(patch.sttBackend, "openai");
assert.equal(patch.sttBaseUrl, "http://127.0.0.1:8800/v1");
assert.equal(patch.sttModel, "SenseVoiceSmall");
assert.ok(!("sttApiKey" in patch), "empty apiKey must be dropped");
patch = core.renderVoicePatch(manifest.integrations?.voiceStt, { baseUrl: "http://h:9/v1", model: "whisper-1", apiKey: "k" });
assert.equal(patch.sttApiKey, "k");
assert.equal(core.renderTemplateString("a{{x}}b{{y}}c", { x: "1", y: "" }), "a1bc");
ok("render: template substitution + empty-value drop");

const snapshot = { sttBackend: "gemini", sttBaseUrl: "https://old.example/v1" };
const applied = { sttBackend: "openai", sttBaseUrl: "http://127.0.0.1:8800/v1", sttModel: "SenseVoiceSmall" };
let plan = core.computeRestorePlan(snapshot, applied, { ...snapshot, ...applied });
assert.equal(plan.sttBackend, "gemini");
assert.equal(plan.sttBaseUrl, "https://old.example/v1");
assert.ok(!("sttModel" in plan), "key absent from snapshot must be deleted");
plan = core.computeRestorePlan(snapshot, applied, { ...snapshot, ...applied, sttModel: "user-edit" });
assert.equal(plan.sttModel, "user-edit", "user edits survive the rollback");
assert.deepEqual(core.computeRestorePlan({}, {}, undefined), {});
ok("restore plan: revert untouched fields, keep user edits, delete new keys");

assert.equal(core.pickLocText({ zh: "中", en: "en" }, "zh"), "中");
assert.equal(core.pickLocText({ zh: "", en: "en" }, "zh"), "en");
assert.equal(core.pickLocText(undefined, "en"), "");
ok("pickLocText: language fallback");

/* ------------- part 2: install-from-directory + lifecycle ------------- */
const sandbox = mkdtempSync(join(tmpdir(), "mpi-appstore-"));
process.env.MPI_TEST_USER_DATA = join(sandbox, "userData");
register(new URL("./electron-stub-loader.mjs", import.meta.url));
const { loadConfig, getConfig, updateConfig } = await import("../src/main/config.ts");
loadConfig(process.env.MPI_TEST_USER_DATA);
const store = await import("../src/main/app-store.ts");
store.setRuntimeDeps({
  loadModule: async () => ({ activate: async () => ({}) }),
  spawnProcess: () => null,
  killProcess: () => {},
  now: () => "2026-09-13T00:00:00.000Z",
});

try {
  assert.equal(store.listApps().length, 0, "nothing installed initially");

  const srcRoot = join(sandbox, "apps-src");
  const appSrc = writeApp(join(srcRoot, "fixture-app"), manifestRaw);
  assert.throws(() => store.installAppFromDir(join(srcRoot, "missing")), /Not an app directory/);
  assert.throws(
    () => store.installAppFromDir(writeApp(join(srcRoot, "bad-id"), manifestFor("Bad_ID"))),
    /Invalid app manifest/,
  );
  await assert.rejects(store.uninstallApp("nope"), /Unknown app/);
  ok("install: rejects missing dir, invalid manifest, unknown uninstall");

  store.installAppFromDir(appSrc);
  let apps = store.listApps();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, "fixture-app");
  assert.equal(apps[0].installed, true);
  assert.equal(apps[0].enabled, false);
  assert.ok(existsSync(join(process.env.MPI_TEST_USER_DATA, "apps", "fixture-app", "mpi-app.json")));
  ok("install: copies app dir into userData + registers as installed/disabled");

  let cfg = store.getAppConfig("fixture-app");
  assert.equal(cfg.baseUrl, "http://127.0.0.1:8800/v1");
  store.saveAppConfig("fixture-app", { baseUrl: "http://192.168.1.50:9000/v1", model: "whisper-1", apiKey: "", bogus: "x" });
  cfg = store.getAppConfig("fixture-app");
  assert.equal(cfg.baseUrl, "http://192.168.1.50:9000/v1");
  assert.equal(cfg.model, "whisper-1");
  assert.ok(!("bogus" in cfg));
  ok("config: defaults + save (unknown keys dropped)");

  updateConfig({ voice: { sttBackend: "gemini", sttBaseUrl: "https://old.example/v1" } });
  await store.setAppEnabled("fixture-app", true);
  let voice = getConfig().voice;
  assert.equal(voice.sttBackend, "openai");
  assert.equal(voice.sttBaseUrl, "http://192.168.1.50:9000/v1");
  assert.equal(voice.sttModel, "whisper-1");
  assert.ok(!("sttApiKey" in voice));
  assert.equal(store.listApps()[0].enabled, true);
  ok("enable: writes rendered template into config.voice");

  updateConfig({ voice: { ...getConfig().voice, sttModel: "user-changed" } });
  await store.setAppEnabled("fixture-app", false);
  voice = getConfig().voice;
  assert.equal(voice.sttBackend, "gemini");
  assert.equal(voice.sttBaseUrl, "https://old.example/v1");
  assert.equal(voice.sttModel, "user-changed");
  ok("disable: restores untouched fields, keeps user edits");

  await store.uninstallApp("fixture-app");
  apps = store.listApps();
  assert.equal(apps.length, 0);
  assert.ok(!existsSync(join(process.env.MPI_TEST_USER_DATA, "apps", "fixture-app")));
  assert.ok(!existsSync(join(process.env.MPI_TEST_USER_DATA, "apps", "configs", "fixture-app.json")));
  ok("uninstall: removes dir, saved values, registry entry");

  // reinstall overwrites a stale directory + resets enable state
  store.installAppFromDir(appSrc);
  await store.setAppEnabled("fixture-app", true);
  store.saveAppConfig("fixture-app", { baseUrl: "http://stale:1234/v1", model: "stale", apiKey: "" });
  writeApp(appSrc, manifestFor("fixture-app", { version: "2.0.0" }));
  store.installAppFromDir(appSrc);
  const reinstalled = store.listApps()[0];
  assert.equal(reinstalled.version, "2.0.0");
  assert.equal(reinstalled.enabled, false, "reinstall resets to disabled");
  assert.equal(
    store.getAppConfig("fixture-app").baseUrl,
    "http://127.0.0.1:8800/v1",
    "version upgrade drops stale saved values so new defaults apply",
  );
  await store.uninstallApp("fixture-app");

  // enable on empty profile then uninstall restores to no voice config
  updateConfig({ voice: undefined });
  store.installAppFromDir(appSrc);
  await store.setAppEnabled("fixture-app", true);
  assert.equal(getConfig().voice.sttBackend, "openai");
  await store.uninstallApp("fixture-app");
  assert.ok(!getConfig().voice || Object.keys(getConfig().voice).length === 0);
  ok("lifecycle: reinstall overwrite + empty-profile restore");

  /* ----------------- part 3: install from zip ----------------- */
  const zip1 = join(sandbox, "zipped.zip");
  await makeZip(zip1, {
    "mpi-app.json": JSON.stringify(manifestFor("zipped-app")),
    "assets/readme.txt": "hello",
  });
  const e1 = await store.installAppFromZip(zip1);
  assert.equal(e1.id, "zipped-app");
  assert.equal(store.listApps().find((a) => a.id === "zipped-app").installed, true);
  assert.equal(readFileSync(join(process.env.MPI_TEST_USER_DATA, "apps", "zipped-app", "assets", "readme.txt"), "utf8"), "hello");
  await store.uninstallApp("zipped-app");
  ok("zip install: extracts package into userData/apps");

  // stored (no compression) archive works too
  const zipStored = join(sandbox, "stored.zip");
  await makeZip(zipStored, { "mpi-app.json": JSON.stringify(manifestFor("stored-app")) }, { compression: "STORE" });
  await store.installAppFromZip(zipStored);
  assert.ok(store.listApps().some((a) => a.id === "stored-app"));
  await store.uninstallApp("stored-app");
  ok("zip install: stored (uncompressed) package");

  // a single wrapping folder is stripped
  const zipWrapped = join(sandbox, "wrapped.zip");
  await makeZip(zipWrapped, {
    "my-app/mpi-app.json": JSON.stringify(manifestFor("wrapped-app")),
    "my-app/service/index.cjs": "module.exports = { activate() {} };",
  });
  await store.installAppFromZip(zipWrapped);
  assert.ok(existsSync(join(process.env.MPI_TEST_USER_DATA, "apps", "wrapped-app", "service", "index.cjs")));
  await store.uninstallApp("wrapped-app");
  ok("zip install: strips one wrapping folder");

  // invalid manifest / no manifest / traversal are rejected
  const zipNoManifest = join(sandbox, "nomanifest.zip");
  await makeZip(zipNoManifest, { "readme.txt": "nothing" });
  await assert.rejects(store.installAppFromZip(zipNoManifest), /mpi-app\.json missing/);
  const zipBadManifest = join(sandbox, "badmanifest.zip");
  await makeZip(zipBadManifest, { "mpi-app.json": JSON.stringify({ ...manifestRaw, id: "Bad_ID" }) });
  await assert.rejects(store.installAppFromZip(zipBadManifest), /Invalid app manifest/);
  const zipEvil = join(sandbox, "evil.zip");
  await makeZip(zipEvil, { "mpi-app.json": JSON.stringify(manifestFor("evil-app")), "../evil.txt": "pwned" });
  await assert.rejects(store.installAppFromZip(zipEvil), /unsafe path/);
  assert.ok(!existsSync(join(sandbox, "evil.txt")));
  ok("zip install: rejects missing/invalid manifest and traversal entries");

  /* ------------- part 4: service-module lifecycle ------------- */
  const svcSrc = join(srcRoot, "plugin-demo");
  writeApp(
    svcSrc,
    {
      ...manifestFor("plugin-demo"),
      config: { fields: [{ key: "baseUrl", type: "url", label: { zh: "地址", en: "URL" }, default: "http://127.0.0.1:9999/v1" }] },
      integrations: { voiceStt: { sttBackend: "openai", sttBaseUrl: "{{baseUrl}}" } },
      service: { entry: "service/index.mjs", autostart: true },
      capabilities: ["process"],
      pi: { extensions: ["pi/ext.ts"] },
    },
    {
      "pi/ext.ts": "export default function () {}\n",
      "service/index.mjs": `export function activate(host) {\n  host.log("demo activating");\n  host.spawn("node", ["-e", "0"]);\n  return { voice: { sttBackend: "openai", sttBaseUrl: host.getFieldValues().baseUrl, sttModel: "demo-model" } };\n}\nexport function deactivate() {}\n`,
    },
  );
  const killed = [];
  store.setRuntimeDeps({
    loadModule: (absPath) => import(pathToFileURL(absPath).href),
    spawnProcess: () => 9999,
    killProcess: (pid) => killed.push(pid),
    now: () => "2026-09-13T00:00:00.000Z",
  });
  updateConfig({ voice: undefined });
  store.installAppFromDir(svcSrc);
  const res = await store.setAppEnabled("plugin-demo", true);
  assert.equal(res.enabled, true);
  assert.equal(res.status.state, "ready");
  voice = getConfig().voice;
  assert.equal(voice.sttBaseUrl, "http://127.0.0.1:9999/v1");
  assert.equal(voice.sttModel, "demo-model");
  assert.ok(store.getAppLogs("plugin-demo").some((l) => l.includes("demo activating")));
  ok("service: enable activates module, applies returned patch, logs, status ready");

  const extPaths = store.getAppExtensionPaths();
  assert.equal(extPaths.length, 1);
  assert.ok(extPaths[0].endsWith(join("apps", "plugin-demo", "pi", "ext.ts")));
  assert.equal(store.checkAppExtensions("plugin-demo").ok, true);
  ok("service: enabled app contributes its pi extensions");

  await store.setAppEnabled("plugin-demo", false);
  assert.deepEqual(killed, [9999]);
  assert.ok(!getConfig().voice || getConfig().voice.sttBackend !== "openai");
  assert.deepEqual(store.getAppExtensionPaths(), [], "disabled app must not contribute extensions");
  ok("service: disable kills managed processes, restores config, drops extensions");

  await store.setAppEnabled("plugin-demo", true);
  store.killAllManagedProcesses();
  await store.activateAutostartApps();
  assert.equal(store.listApps().find((a) => a.id === "plugin-demo").status.state, "ready");
  ok("service: autostart re-activates enabled services without rewriting config");

  const rr = await store.restartAppService("plugin-demo");
  assert.equal(rr.enabled, true);
  assert.equal(rr.status.state, "ready");
  await store.uninstallApp("plugin-demo");
  ok("service: restart re-activates the service and reports ready");

  console.log(`\napp-store: all ${passed} checks passed`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
