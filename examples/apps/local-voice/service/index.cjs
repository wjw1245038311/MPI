"use strict";
/**
 * local-voice service module — the app's lifecycle entry point (manifest
 * `service.entry`). MPI loads this in its main process and calls activate()
 * when the app is enabled and deactivate() when disabled.
 *
 * Zero-config strategy:
 *   • If the user filled in a "Service URL", just probe it and wire MPI to it.
 *   • Otherwise run the bundled sherpa-onnx server (service/server.cjs) with the
 *     runtime + model shipped INSIDE this app package, using MPI's own
 *     executable as a Node runtime via ELECTRON_RUN_AS_NODE (no system node).
 *
 * The module never touches config: activate() returns a `voice` patch and MPI
 * applies/rolls it back with the same fingerprint logic as declarative apps.
 */
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_PORT = 8800;
const START_TIMEOUT_MS = 90000;

/** Resolve `${base}/models` — 2xx/404 means reachable; 401/403 means auth error. */
function probeModels(base, timeoutMs) {
  const url = `${base.replace(/\/+$/, "")}/models`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (!done) {
        done = true;
        resolve(result);
      }
    };
    const req = http.get(url, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 500 && res.statusCode !== 401 && res.statusCode !== 403) finish({ ok: true });
      else if (res.statusCode === 401 || res.statusCode === 403) finish({ ok: false, error: "auth" });
      else finish({ ok: false, error: `http ${res.statusCode}` });
    });
    req.on("error", (e) => finish({ ok: false, error: e.code || e.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ ok: false, error: "timeout" });
    });
  });
}

/** Is a TCP port free on the loopback interface? */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/** Ask the OS for a free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the server answers /models or the timeout elapses. */
async function waitReady(base, timeoutMs, log) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await probeModels(base, 1500);
    if (res.ok) return true;
    if (res.error && res.error !== "ECONNREFUSED" && res.error !== "timeout" && res.error !== "ECONNRESET") {
      log(`[local-voice] probe error: ${res.error}`);
    }
    await sleep(1000);
  }
  return false;
}

function voicePatch(baseUrl, modelName) {
  const patch = { sttBackend: "openai", sttBaseUrl: baseUrl, sttModel: (modelName || "").trim() || "SenseVoiceSmall" };
  return patch;
}

module.exports.activate = async function activate(host) {
  const dir = host.app.dir;
  const values = host.getFieldValues();
  const customBase = (values.baseUrl || "").trim();
  const modelName = (values.modelName || "").trim() || "SenseVoiceSmall";

  const runtimeOk = fs.existsSync(path.join(dir, "runtime", "node_modules", "sherpa-onnx-node"));
  const modelOk = fs.existsSync(path.join(dir, "model", "model.json"));
  const hasBundled = runtimeOk && modelOk;

  // Mode 1 — the user configured an STT endpoint: probe it. If it is down but
  // this package ships a runtime + model, fall back to the bundled server
  // instead of failing (a leftover/stale URL must not brick the app).
  if (customBase) {
    host.log(`[local-voice] using configured endpoint ${customBase}`);
    const res = await probeModels(customBase, 5000);
    if (res.ok) {
      host.status("ready", "connected to configured endpoint");
      return { voice: voicePatch(customBase, modelName) };
    }
    const detail = res.error === "auth" ? "configured endpoint rejected the request (401/403)" : `cannot reach configured endpoint (${res.error})`;
    if (!hasBundled) {
      host.log(`[local-voice] ${detail}; no bundled runtime/model to fall back to`);
      host.status("error", detail);
      return {};
    }
    host.log(`[local-voice] ${detail}; falling back to the bundled server`);
  }

  // Mode 2 — self-contained: run the bundled runtime + model.
  const serverEntry = path.join(dir, "service", "server.cjs");
  if (!hasBundled) {
    const missing = [!runtimeOk && "runtime/", !modelOk && "model/"].filter(Boolean).join(" + ");
    const msg = `app package is missing ${missing} — rebuild it with scripts/build-app-pack.mjs`;
    host.log(`[local-voice] ${msg}`);
    host.status("error", msg);
    return {};
  }

  let port = Number(values.port) || DEFAULT_PORT;
  if (!(await isPortFree(port))) {
    const fallback = await freePort();
    host.log(`[local-voice] port ${port} is busy; falling back to ${fallback}`);
    port = fallback;
  }
  const base = `http://127.0.0.1:${port}/v1`;
  const pid = host.spawn(host.execPath, [serverEntry, "--port", String(port)], {
    env: { ELECTRON_RUN_AS_NODE: "1" },
    shell: false,
  });
  if (pid == null) {
    host.status("error", "failed to start the bundled server (missing process capability?)");
    return {};
  }
  host.log(`[local-voice] spawned bundled server pid=${pid} -> ${base}`);

  if (!(await waitReady(base, START_TIMEOUT_MS, (l) => host.log(l)))) {
    host.status("error", "bundled server did not become ready in time — open the log and look for [child] lines for the real error");
    return {};
  }
  host.status("ready");
  return { voice: voicePatch(base, modelName) };
};

module.exports.deactivate = function deactivate(host) {
  // MPI reaps every child process this activation spawned; nothing else to do.
  host.log("[local-voice] deactivated (bundled server reaped by MPI)");
};
