// Dev diagnostic: verify src/main/tui.ts survives out-of-order start/stop IPCs
// (React StrictMode double-mount in dev, fast user toggling). The exact race:
//   START#1 -> STOP(unconditional) -> START#2
// must end with exactly ONE live PTY owned by START#2's generation, and NO
// spurious tui:exit events (which would yank the UI back to GUI mode).
//
// Runs under plain node: `electron` is redirected to a stub via a require hook,
// so no real Electron window opens. The bundle is produced by
// scripts/build-tui-race-bundle.mjs first (see npm script test:tuirace).
const Module = require("module");
const os = require("os");
const path = require("path");
const fs = require("fs");

let failures = 0;
function check(name, cond) {
  console.log(`[tui-race] ${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond) failures++;
}

// --- electron stub (only runtime-package touches `app`, and only isPackaged).
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-tui-race-"));
const electronStub = {
  app: {
    isPackaged: false,
    getPath: () => userData,
  },
};
// Patch the resolver so `require("electron")` returns an in-memory stub module.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return "__ELECTRON_STUB__";
  return origResolve.call(this, request, ...rest);
};
require.cache["__ELECTRON_STUB__"] = { id: "__ELECTRON_STUB__", filename: "__ELECTRON_STUB__", loaded: true, exports: electronStub };

// --- load the bundle and a throwaway config.
const mod = require("./.tui-race-bundle.cjs");
mod.loadConfig(userData); // getConfig() must not throw inside tui:start

const handlers = {};
const fakeIpcMain = { handle: (ch, fn) => (handlers[ch] = fn) };
const events = [];
mod.registerTuiIpc(fakeIpcMain, (ch, p) => events.push([ch, p]));

const cwd = process.cwd();
const start = (threadId) => handlers["tui:start"]({}, { threadId, cwd, sessionFile: null });
const stop = (threadId, gen) => handlers["tui:stop"]({}, { threadId, ...(gen !== undefined ? { gen } : {}) });

(async () => {
  // Pre-warm the runtime cache so tui:start resolves in a microtask (the fast
  // path where an in-flight start can FINISH before a stop lands).
  const warm = await start("warm");
  check("pre-warm start succeeds", warm.ok === true);
  await stop("warm");

  // --- Race 1: StrictMode pattern — start, immediate unconditional stop, new start.
  const p1 = start("t"); // suspends at runtime resolution / spawn
  await new Promise((r) => setImmediate(r)); // let START#1 finish spawning (fast path)
  await stop("t"); // cleanup#1 lands while/after START#1 is in flight
  const p2 = start("t");
  const [r1, r2] = await Promise.all([p1, p2]);

  check("second start succeeds", r2.ok === true);
  check(
    "exactly one live PTY after the race (owned by second start)",
    JSON.stringify(mod.tuiDebugSessions()) === JSON.stringify({ t: r2.gen }),
  );
  check(
    "no spurious tui:exit events (would force auto-exit to GUI)",
    !events.some(([ch]) => ch === "tui:exit"),
  );

  // --- Race 2: stale conditional stop must not kill the newer terminal.
  if (r1.ok && r1.gen !== undefined) {
    await stop("t", r1.gen); // IIFE#1's late orphan-cleanup, carrying its own gen
    check(
      "stale conditional stop leaves the new PTY alive",
      JSON.stringify(mod.tuiDebugSessions()) === JSON.stringify({ t: r2.gen }),
    );
  } else {
    console.log("[tui-race] (r1 was superseded in-flight — conditional-stop case skipped)");
  }

  // --- Race 3: unconditional stop still kills the live PTY.
  await stop("t");
  check("unconditional stop clears the session", Object.keys(mod.tuiDebugSessions()).length === 0);

  mod.stopAllTuis();
  console.log(failures === 0 ? "[tui-race] ALL PASS" : `[tui-race] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("[tui-race] crashed:", e);
  process.exit(2);
});
