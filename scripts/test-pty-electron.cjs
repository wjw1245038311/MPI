// Dev diagnostic: verify the node-pty prebuilt binary loads and works inside
// this project's Electron runtime (spawn / data / resize / kill). Exits 0 on
// success. Run with: npx electron scripts/test-pty-electron.cjs
const { app } = require("electron");

app.whenReady().then(async () => {
  console.log("[test] electron", process.versions.electron, "node", process.versions.node, "ABI", process.versions.modules);
  try {
    const pty = require("../node_modules/node-pty");
    const shell = process.platform === "win32" ? "cmd.exe" : ["/bin/sh"];
    const term = pty.spawn(shell, [], { cols: 80, rows: 24, cwd: process.cwd(), name: "xterm-color" });
    let got = "";
    term.onData((d) => (got += d));
    setTimeout(() => term.write("echo hello-pty-ok\r"), 500);
    setTimeout(() => {
      console.log("[test] pty spawn OK, data bytes:", got.length, "contains marker:", got.includes("hello-pty-ok"));
      try {
        term.resize(100, 30);
        console.log("[test] resize OK");
      } catch (e) {
        console.error("[test] resize FAIL:", e.message);
      }
      const t0 = Date.now();
      try {
        term.kill();
        console.log("[test] kill() returned synchronously in", Date.now() - t0, "ms");
      } catch (e) {
        console.error("[test] kill() THREW:", e.message);
      }
      // Give the async conpty cleanup a moment, then force-exit.
      setTimeout(() => process.exit(got.includes("hello-pty-ok") ? 0 : 2), 800);
    }, 1500);
  } catch (e) {
    console.error("[test] PTY LOAD/SPAWN FAIL:", e.message);
    app.exit(1);
  }
});
