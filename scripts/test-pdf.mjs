import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { readPreview } = await import("../src/main/preview-service.ts");

// ---------------------------------------------------------------------------
// Minimal valid single-page PDF (no xref table — pdf.js reconstructs it).
// Exercises both halves of the pipeline: main-side readPreview kind detection
// and pdfjs-dist parsing/text extraction.
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "mpi-pdf-"));
try {
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
  const file = join(dir, "sample.pdf");
  writeFileSync(file, pdf);

  // main side: kind detection + base64 payload (same shape PdfPreview consumes)
  const payload = readPreview(file);
  assert.equal(payload.kind, "pdf", `expected kind pdf, got ${payload.kind}`);
  assert.equal(payload.mime, "application/pdf");
  assert.ok(Buffer.from(payload.base64 || "", "base64").length > 0, "base64 present");

  // Parse + text extraction. The browser build's crypto shim breaks under
  // plain Node, so the test uses the legacy build (same parser core); the
  // renderer path (browser build + Blob module worker) is verified in-app.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.from(payload.base64, "base64")) }).promise;
  assert.equal(doc.numPages, 1);
  const page = await doc.getPage(1);
  const textContent = await page.getTextContent();
  const text = textContent.items.map((item) => item.str).join(" ");
  assert.match(text, /Hello MPI pdf test/);

  console.log("pdf pipeline: all assertions passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
