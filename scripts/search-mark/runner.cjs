// Runs a bundled DOM test in real Chromium (project's Electron) and prints results.
// Usage: electron run-dom.cjs <bundle.js> [timeoutMs]
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const bundlePath = process.argv[2];
const timeoutMs = Number(process.argv[3]) || 15000;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html,<html><body><div id='root'></div></body></html>");
  const code = fs.readFileSync(bundlePath, "utf8");
  await win.webContents.executeJavaScript(code);

  const deadline = Date.now() + timeoutMs;
  let raw = null;
  while (Date.now() < deadline) {
    raw = await win.webContents.executeJavaScript(
      `window.__result ? JSON.stringify(window.__result) : null`
    );
    if (raw) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!raw) {
    console.log("TIMEOUT waiting for test result");
    app.exit(2);
    return;
  }
  const { failures, log } = JSON.parse(raw);
  console.log(log.join("\n"));
  console.log(failures === 0 ? "tests passed" : failures + " FAILURES");
  app.exit(failures === 0 ? 0 : 1);
});
