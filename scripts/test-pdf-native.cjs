// Smoke test: does the built-in Chromium PDF viewer render an mpipdf:// URL
// from a web (http) origin — i.e. exactly what MPI's dev mode does? If a
// future Electron drops the viewer or blocks custom-scheme PDFs, this fails
// and we know to lean on the canvas/pdfjs fallback instead.
// Hidden window + screenshot — nothing is shown on screen.
const { app, BrowserWindow, protocol } = require("electron");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// NOTE: in Electron main with open windows/servers, process.exit() can return
// without terminating (observed on v33) — so control flow uses a flag and a
// single exit point at the end instead of early exits.

// Must run before app ready — mirrors src/main/pdf-viewer-protocol.ts.
protocol.registerSchemesAsPrivileged([
  { scheme: "mpipdf", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let dir;
try {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-pdf-native-"));
  const streamContent = "BT /F1 24 Tf 72 720 Td (Hello MPI pdf test) Tj ET";
  const pdf = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "endobj",
    `4 0 obj`,
    `<< /Length ${streamContent.length} >>`,
    "stream",
    streamContent,
    "endstream",
    "endobj",
    "5 0 obj",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "endobj",
    "trailer",
    "<< /Size 6 /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  const pdfPath = path.join(dir, "sample.pdf");
  fs.writeFileSync(pdfPath, pdf);

  // Same URL shape as src/main/pdf-viewer-protocol.ts: mpipdf://file/<base64url(absPath)>
  // (payload in pathname — hostnames get lowercased by the URL parser)
  const pdfUrl = "mpipdf://file/" + Buffer.from(pdfPath, "utf8").toString("base64url");

  app.whenReady().then(() => {
    // protocol.handle requires the app to be ready (same as src/main/index.ts).
    protocol.handle("mpipdf", (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("no", { status: 405 });
      const encoded = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, "");
      const target = Buffer.from(encoded, "base64url").toString("utf8");
      if (!path.isAbsolute(target) || !fs.existsSync(target)) return new Response("nf", { status: 404 });
      const buf = fs.readFileSync(target);
      const range = request.headers.get("range");
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m && (m[1] || m[2])) {
          const start = m[1] ? Number(m[1]) : 0;
          const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
          if (start <= end && start < buf.length) {
            return new Response(buf.subarray(start, end + 1), {
              status: 206,
              headers: { "Content-Type": "application/pdf", "Content-Range": `bytes ${start}-${end}/${buf.length}` },
            });
          }
        }
      }
      return new Response(request.method === "HEAD" ? "" : buf, {
        status: 200,
        headers: { "Content-Type": "application/pdf", "Accept-Ranges": "bytes" },
      });
    } catch (e) {
      return new Response(String(e?.message || "bad"), { status: 400 });
    }
    });
  });

  app.whenReady().then(async () => {
    let server;
    let exitCode = 0;
    try {
      // Serve the iframe page over http — exactly like electron-vite dev mode.
      server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        // Mirror the CSP from src/renderer/index.html — frame-src must list
        // mpipdf: or the iframe is blocked and renders blank.
        const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: todoatt:; font-src 'self' data:; connect-src 'self' data: blob:; frame-src 'self' pi-preview: mpipdf: data: blob:; media-src 'self' blob:";
        res.end(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body style="margin:0"><iframe src="${pdfUrl}" width="420" height="560"></iframe></body></html>`);
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const port = server.address().port;

      const win = new BrowserWindow({ show: false, width: 500, height: 640 });
      await win.loadURL(`http://127.0.0.1:${port}/`);
      // Give the PDF viewer time to load + render.
      await new Promise((r) => setTimeout(r, 6000));
      const png = (await win.webContents.capturePage()).toPNG();
      const shot = path.join(dir, "capture.png");
      fs.writeFileSync(shot, png);
      // A rendered page (dark toolbar + white page) compresses to far more
      // than a blank frame would. Threshold is deliberately generous.
      if (png.length < 8_000) {
        console.error(`FAIL: capture only ${png.length} bytes — built-in PDF viewer likely missing or blocked (${shot})`);
        exitCode = 1;
      } else {
        console.log(`ok: native PDF viewer rendered mpipdf:// from http origin (${png.length} byte capture)`);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`FAIL: ${e.message} (capture kept at ${path.join(dir, "capture.png")})`);
      exitCode = 1;
    } finally {
      if (server) server.close();
    }
    process.exit(exitCode);
  });
} catch (e) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  console.error(`FAIL: setup error: ${e.message}`);
  process.exit(1);
}
