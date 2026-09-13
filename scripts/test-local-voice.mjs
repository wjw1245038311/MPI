/**
 * local-voice example package — end-to-end through the real App Store.
 *
 * Installs examples/apps/local-voice as a directory package (with the sherpa
 * runtime + model taken from the dev spike via junctions), enables it with the
 * REAL runtime deps (so it actually spawns service/server.cjs), and POSTs a WAV
 * to the OpenAI-compatible endpoint it starts.
 *
 * Requires the local sherpa spike artifacts (tmp/sherpa-spike). When they are
 * absent this test is skipped by run-all-tests.mjs; running it directly prints
 * a notice and exits 0 so it never breaks a bare checkout / CI.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPIKE = join(ROOT, "tmp", "sherpa-spike");
const MODEL_DIR = join(SPIKE, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09");
const APP_SRC = join(ROOT, "examples", "apps", "local-voice");

const runtimeOk = existsSync(join(SPIKE, "node_modules", "sherpa-onnx-node"));
const modelOk = existsSync(join(MODEL_DIR, "model.int8.onnx")) && existsSync(join(MODEL_DIR, "tokens.txt"));
if (!runtimeOk || !modelOk) {
  console.log("SKIP local-voice: sherpa spike artifacts not present under tmp/sherpa-spike");
  process.exit(0);
}

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`PASS ${name}`);
};

const sandbox = mkdtempSync(join(tmpdir(), "mpi-local-voice-"));
const SRC = join(sandbox, "src");
const USERDATA = join(sandbox, "userData");

mkdirSync(join(SRC, "service"), { recursive: true });
mkdirSync(join(SRC, "runtime", "node_modules"), { recursive: true });
writeFileSync(join(SRC, "mpi-app.json"), readFileSync(join(APP_SRC, "mpi-app.json")));
for (const f of ["index.cjs", "server.cjs"]) writeFileSync(join(SRC, "service", f), readFileSync(join(APP_SRC, "service", f)));
for (const pkg of ["sherpa-onnx-node", "sherpa-onnx-win-x64"]) {
  if (existsSync(join(SPIKE, "node_modules", pkg))) {
    symlinkSync(join(SPIKE, "node_modules", pkg), join(SRC, "runtime", "node_modules", pkg), "junction");
  }
}
symlinkSync(MODEL_DIR, join(SRC, "model"), "junction");
writeFileSync(
  join(MODEL_DIR, "model.json"),
  JSON.stringify({ type: "senseVoice", model: "model.int8.onnx", tokens: "tokens.txt", name: "SenseVoiceSmall", language: "auto" }, null, 2),
);

process.env.MPI_TEST_USER_DATA = USERDATA;
register(new URL("./electron-stub-loader.mjs", import.meta.url));

let store;
try {
  const { loadConfig, getConfig } = await import("../src/main/config.ts");
  loadConfig(USERDATA);
  store = await import("../src/main/app-store.ts");

  const entry = store.installAppFromDir(SRC);
  assert.equal(entry.id, "local-voice");
  assert.equal(store.listApps()[0].installed, true);
  ok("example: directory install through the app store");

  const res = await store.setAppEnabled("local-voice", true);
  assert.equal(res.status.state, "ready", `enable failed: ${res.status.detail || res.status.state}`);
  // The ready status must surface the live base URL + model name (copy-over on a fresh machine).
  assert.ok(
    res.status.detail && res.status.detail.includes("127.0.0.1") && res.status.detail.includes("SenseVoiceSmall"),
    `status detail should show base URL + model name, got: ${res.status.detail}`,
  );
  const voice = getConfig().voice;
  assert.equal(voice.sttBackend, "openai");
  assert.ok(voice.sttBaseUrl && voice.sttBaseUrl.startsWith("http://127.0.0.1:"), "voice must point at the bundled server");
  assert.equal(voice.sttModel, "SenseVoiceSmall", "sttModel must be the bundled model's real name from model.json");
  assert.ok(store.getAppLogs("local-voice").some((l) => l.includes("spawned bundled server")), "service log records the spawn");
  ok("example: enable spawns the bundled server and wires config.voice");

  const models = await (await fetch(`${voice.sttBaseUrl}/models`)).json();
  assert.ok(Array.isArray(models.data) && models.data.length > 0, "GET /v1/models returns a list");
  ok("example: OpenAI-compatible GET /v1/models");

  const wav = readFileSync(join(MODEL_DIR, "test_wavs", "zh.wav"));
  const fd = new FormData();
  fd.append("model", voice.sttModel);
  fd.append("file", new Blob([wav], { type: "audio/wav" }), "recording.wav");
  const out = await (await fetch(`${voice.sttBaseUrl}/audio/transcriptions`, { method: "POST", body: fd })).json();
  assert.ok(out.text && out.text.length > 0, `expected transcription text, got ${JSON.stringify(out)}`);
  ok("example: bundled server transcribes WAV to text");

  // Simulate an in-place app update (reinstall replaces <userData>/apps/<id>):
  // the running main process must pick up the new code WITHOUT a restart.
  const idxPath = join(USERDATA, "apps", "local-voice", "service", "index.cjs");
  const patched = readFileSync(idxPath, "utf8").replace(
    'host.status("ready", `${base} · ${actualModel}`);',
    'host.status("ready", `${base} · ${actualModel} (v2)`);',
  );
  assert.ok(patched.includes("(v2)"), "test setup: could not patch index.cjs ready status line");
  writeFileSync(idxPath, patched);
  await store.setAppEnabled("local-voice", false);
  const res2 = await store.setAppEnabled("local-voice", true);
  assert.equal(res2.status.state, "ready", `re-enable after update failed: ${res2.status.detail || res2.status.state}`);
  assert.ok(
    res2.status.detail && res2.status.detail.includes("(v2)"),
    `updated service code was not picked up (stale module cache?): ${res2.status.detail}`,
  );
  ok("example: in-place app update is picked up without restarting MPI");

  await store.setAppEnabled("local-voice", false);
  const after = getConfig().voice;
  assert.ok(!after || after.sttBackend !== "openai", "disabling rolls back the voice wiring");
  assert.deepEqual(store.getAppExtensionPaths(), []);
  ok("example: disable reaps the server and restores voice config");

  console.log(`\nlocal-voice: all ${passed} checks passed`);
} finally {
  try {
    store?.killAllManagedProcesses();
  } catch {
    /* ignore */
  }
  rmSync(sandbox, { recursive: true, force: true });
}
