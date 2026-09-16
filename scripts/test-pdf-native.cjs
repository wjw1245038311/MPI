// Smoke test: does this Electron build still render PDFs natively in an
// <iframe src="file://..."> (built-in Chromium/PDFium viewer)? MPI's primary
// PDF preview path relies on it; if a future Electron drops the viewer, this
// fails and we know to lean on the canvas/pdfjs fallback instead.
// Hidden window + screenshot — nothing is shown on screen.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

function fail(msg) {
  // process.exit (not app.exit): must stop this script immediately.
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

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

  const fileUrl = "file:///" + pdfPath.replace(/\\/g, "/");
  const html = `<!doctype html><html><body style="margin:0">
<iframe src="${fileUrl}" width="420" height="560"></iframe>
</body></html>`;
  fs.writeFileSync(path.join(dir, "test.html"), html);

  app.whenReady().then(async () => {
    try {
      const win = new BrowserWindow({ show: false, width: 500, height: 640 });
      await win.loadFile(path.join(dir, "test.html"));
      // Give the PDF viewer time to load + render.
      await new Promise((r) => setTimeout(r, 5000));
      const png = (await win.webContents.capturePage()).toPNG();
      const shot = path.join(dir, "capture.png");
      fs.writeFileSync(shot, png);
      // A rendered page (dark toolbar + white page) compresses to far more
      // than a blank frame would. Threshold is deliberately generous.
      if (png.length < 8_000) {
        fail(`capture only ${png.length} bytes — built-in PDF viewer likely missing (${shot})`);
      }
      console.log(`ok: native PDF viewer rendered (${png.length} byte capture)`);
      fs.rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    } catch (e) {
      fail(`${e.message} (capture kept at ${path.join(dir, "capture.png")})`);
    }
  });
} catch (e) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  console.error(`FAIL: setup error: ${e.message}`);
  process.exit(1);
}
