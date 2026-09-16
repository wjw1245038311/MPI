import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { readPreview } = await import("../src/main/preview-service.ts");

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

  // DocxPreview passes BOTH input keys. mammoth's package.json `browser` field
  // makes Vite bundle browser/unzip.js (accepts only {arrayBuffer}), while the
  // Node entry lib/unzip.js accepts only {path}/{buffer} — each build reads its
  // own key and ignores the other, so dual keys work in every configuration.
  const mammothBrowser = (await import("../node_modules/mammoth/mammoth.browser.js")).default;
  const mammothNode = (await import("../node_modules/mammoth/lib/index.js")).default;
  // Copy to a fresh typed array: JSZip's nodebuffer may be a pooled Buffer
  // whose .buffer has a non-zero byteOffset.
  const u8 = new Uint8Array(bytes);
  const input = { arrayBuffer: u8.buffer, buffer: u8 };

  // The app's actual path: browser build + dual keys.
  const resBrowser = await mammothBrowser.convertToHtml(input);
  assert.match(resBrowser.value, /Hello MPI docx test/, "browser build round trip");
  // Robustness if a bundler ever picks the Node entry instead.
  const resNode = await mammothNode.convertToHtml(input);
  assert.match(resNode.value, /Hello MPI docx test/, "node entry round trip");

  // Each key alone is rejected by the other build — why both must be passed.
  await assert.rejects(
    () => mammothBrowser.convertToHtml({ buffer: new Uint8Array(bytes) }),
    /Could not find file in options/,
    "browser build rejects {buffer}-only",
  );
  await assert.rejects(
    () => mammothNode.convertToHtml({ arrayBuffer: bytes.buffer }),
    /Could not find file in options/,
    "node entry rejects {arrayBuffer}-only",
  );

  // OLE2 magic detection: a .docx that is really an old Word file must get a
  // clear message instead of a cryptic zip error from mammoth.
  const ole2 = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(512),
  ]);
  const fakeDocx = join(dir, "renamed.docx");
  writeFileSync(fakeDocx, ole2);
  const renamed = readPreview(fakeDocx);
  assert.equal(renamed.kind, "unsupported");
  assert.match(renamed.message || "", /legacy Office format/);

  // Explicit legacy extensions get guidance too.
  const oldDoc = join(dir, "old.doc");
  writeFileSync(oldDoc, ole2);
  const legacy = readPreview(oldDoc);
  assert.equal(legacy.kind, "unsupported");
  assert.match(legacy.message || "", /re-save as \.docx\/\.pptx/);

  console.log("docx pipeline: all assertions passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
