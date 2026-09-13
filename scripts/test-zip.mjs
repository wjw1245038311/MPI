/** zip.ts tests — dependency-free zip reading/extraction. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { extractZip, listZipEntries, readZipEntry, safeZipDest } from "../src/main/zip.ts";

let passed = 0;
function ok(name) {
  passed++;
  console.log(`PASS ${name}`);
}

const sandbox = mkdtempSync(join(tmpdir(), "mpi-zip-"));

async function makeZip(file, files, opts = {}) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: opts.compression || "DEFLATE" });
  writeFileSync(file, buf);
}

try {
  const zipPath = join(sandbox, "a.zip");
  await makeZip(zipPath, {
    "a.txt": "hello zip",
    "b/c.bin": Buffer.from([0, 1, 2, 3, 4, 255]),
    "d.txt": "stored data",
  });

  // list + read (deflate)
  const entries = listZipEntries(zipPath);
  const names = entries.filter((e) => !e.name.endsWith("/")).map((e) => e.name).sort();
  assert.deepEqual(names, ["a.txt", "b/c.bin", "d.txt"]);
  assert.ok(entries.some((e) => e.name === "b/"), "directory entry is listed");
  assert.equal(entries.find((e) => e.name === "a.txt").method, 8, "jszip default is deflate");
  assert.equal(readZipEntry(zipPath, "a.txt").toString("utf8"), "hello zip");
  assert.deepEqual([...readZipEntry(zipPath, "b/c.bin")], [0, 1, 2, 3, 4, 255]);
  assert.equal(readZipEntry(zipPath, "missing.txt"), null);
  ok("zip: list + read entries (deflate)");

  // stored method
  const storedZip = join(sandbox, "stored.zip");
  await makeZip(storedZip, { "s.txt": "plain" }, { compression: "STORE" });
  assert.equal(listZipEntries(storedZip)[0].method, 0);
  assert.equal(readZipEntry(storedZip, "s.txt").toString("utf8"), "plain");
  ok("zip: stored (no compression) entries");

  // extraction
  const out = join(sandbox, "out");
  await extractZip(zipPath, out);
  assert.equal(readFileSync(join(out, "a.txt"), "utf8"), "hello zip");
  assert.equal(readFileSync(join(out, "d.txt"), "utf8"), "stored data");
  assert.deepEqual([...readFileSync(join(out, "b", "c.bin"))], [0, 1, 2, 3, 4, 255]);
  ok("zip: extract preserves directories + bytes");

  // wrapping folder + stripPrefix
  const wrapped = join(sandbox, "wrapped.zip");
  await makeZip(wrapped, {
    "myapp/mpi-app.json": '{"id":"x"}',
    "myapp/service/index.cjs": "module.exports={}",
    "myapp/sub/deep.txt": "deep",
  });
  const out2 = join(sandbox, "out2");
  await extractZip(wrapped, out2, "myapp");
  assert.equal(readFileSync(join(out2, "mpi-app.json"), "utf8"), '{"id":"x"}');
  assert.ok(existsSync(join(out2, "service", "index.cjs")));
  assert.equal(readFileSync(join(out2, "sub", "deep.txt"), "utf8"), "deep");
  ok("zip: strip single wrapping folder while extracting");

  // path safety
  const base = join(sandbox, "dest");
  assert.equal(safeZipDest(base, "a/b.txt"), join(base, "a", "b.txt"));
  for (const bad of ["../evil.txt", "/abs.txt", "C:\\win.txt", "a/../../x", "..", ""]) {
    assert.equal(safeZipDest(base, bad), null, `expected unsafe: ${JSON.stringify(bad)}`);
  }
  ok("zip: safeZipDest rejects traversal/absolute/empty paths");

  // extraction rejects an archive with a traversal entry
  const evil = join(sandbox, "evil.zip");
  await makeZip(evil, { "../evil.txt": "pwned" });
  let threw = false;
  try {
    await extractZip(evil, join(sandbox, "evil-out"));
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "traversal entry must abort extraction");
  assert.ok(!existsSync(join(sandbox, "evil.txt")), "traversal target must not be written");
  ok("zip: extraction aborts on traversal entry");

  console.log(`\nzip: all ${passed} checks passed`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
