import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression test for the docx preview pipeline. DocxPreview (renderer) calls
// mammoth's Node entry with `{ buffer: Uint8Array }` — Vite bundles the Node
// entry, whose openZip rejects the browser-build-only `arrayBuffer` key with
// "Could not find file in options". This test exercises that exact call shape.

const dir = mkdtempSync(join(tmpdir(), "mpi-docx-"));
try {
  // Build a minimal valid .docx (the two parts mammoth needs) with JSZip.
  const JSZip = (await import("../node_modules/jszip/dist/jszip.min.js")).default;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello MPI docx test</w:t></w:r></w:p></w:body></w:document>',
  );
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  // Same entry + call shape as DocxPreview (mammoth Node entry, buffer key).
  const mammoth = (await import("../node_modules/mammoth/lib/index.js")).default;
  const res = await mammoth.convertToHtml({ buffer: new Uint8Array(bytes) });
  assert.match(res.value, /Hello MPI docx test/, "text content survives the round trip");

  // The old broken call shape must be what this test guards against.
  await assert.rejects(
    () => mammoth.convertToHtml({ arrayBuffer: bytes.buffer }),
    /Could not find file in options/,
    "arrayBuffer key is rejected by the Node entry (why the fix exists)",
  );

  console.log("docx pipeline: all assertions passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
