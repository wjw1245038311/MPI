// 验证「壳内扫码」路径：WebView 已在 PWA 首页 → loadUrl 只改 hash（same-document 导航）
// → PWA 必须通过 hashchange 监听器自动开始配对。Electron 与 WebView 同为 Blink，行为一致。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const DIST = path.join(__dirname, "..", "mobile", "pwa", "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL(base);
  await sleep(1000); // React 渲染配对页
  await win.webContents.executeJavaScript("window.__probe = 'alive'");
  const before = await win.webContents.executeJavaScript("document.body.innerText");

  // payload：relayUrl 指向必拒端口 → runPairing 会在 ~1s 内报 "cannot reach relay"（可观测信号）
  const payloadObj = { hostId: "test-host-0001", ticket: "tkt-debug", expiresAt: Date.now() + 3600e3, relayUrl: "wss://127.0.0.1:9/ws" };
  const b64u = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");

  // 与 MainActivity.loadExternal 完全一致：同源、仅 hash 不同的 loadUrl
  await win.webContents.loadURL(`${base}#pair=${b64u}`);

  let after = "";
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    after = await win.webContents.executeJavaScript("document.body.innerText");
    if (/relay|中继/i.test(after) && after !== before) break;
  }

  const probeAlive = await win.webContents.executeJavaScript("window.__probe === 'alive'");
  const triggered = /cannot reach relay|无法连接.*中继|relay/i.test(after) && after !== before;
  console.log("=== BEFORE (前300字) ===\n" + before.slice(0, 300));
  console.log("\n=== AFTER (前500字) ===\n" + after.slice(0, 500));
  console.log(`\nsame-document 导航（__probe 存活）: ${probeAlive ? "是" : "否（发生了整页重载，测试无效）"}`);
  console.log(triggered && probeAlive ? "\nHASHCHANGE-AUTOPAIR: PASS" : "\nHASHCHANGE-AUTOPAIR: FAIL");

  server.close();
  app.exit(triggered && probeAlive ? 0 : 1);
});
