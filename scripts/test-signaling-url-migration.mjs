/** Signaling URL cleanup (mobile 残留) — the rename-era public endpoint was never
 * deployed; fresh configs default to "" and saved copies of the dead URL are
 * normalized away at load time, while user-configured URLs stay untouched. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig, DEFAULT_REMOTE_SIGNALING_URL, LEGACY_PUBLIC_SIGNALING_URL } = await import("../src/main/config.ts");

let passed = 0;
function ok(name) {
  passed++;
  console.log(`PASS ${name}`);
}

assert.equal(DEFAULT_REMOTE_SIGNALING_URL, "", "default signaling URL is empty (legacy path disabled by default)");

const dir = mkdtempSync(join(tmpdir(), "mpi-signal-url-"));
try {
  // Fresh profile: no config file -> empty default.
  assert.equal(loadConfig(dir).remoteSignalingUrl, "");
  ok("fresh profile defaults to empty signaling URL");

  // Saved copy of the never-deployed public endpoint is normalized away.
  writeFileSync(join(dir, "config.json"), JSON.stringify({ remoteSignalingUrl: LEGACY_PUBLIC_SIGNALING_URL }));
  assert.equal(loadConfig(dir).remoteSignalingUrl, "", "dead public URL -> empty");
  ok("saved dead public URL is normalized to empty at load");

  // A user-configured endpoint (e.g. a local signaling server) is preserved.
  writeFileSync(join(dir, "config.json"), JSON.stringify({ remoteSignalingUrl: "ws://192.168.1.10:8787/ws" }));
  assert.equal(loadConfig(dir).remoteSignalingUrl, "ws://192.168.1.10:8787/ws");
  ok("user-configured local URL is preserved");

  // Explicit empty stays empty (no fallback to a dead default).
  writeFileSync(join(dir, "config.json"), JSON.stringify({ remoteSignalingUrl: "" }));
  assert.equal(loadConfig(dir).remoteSignalingUrl, "");
  ok("explicit empty stays empty");

  console.log(`\n${passed} groups passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
