#!/usr/bin/env node
/**
 * Write a `.sha256` sidecar next to each built installer so users can verify
 * downloads before installing (see the in-app changelog modal, 「安装校验方法」).
 *
 * Run after electron-builder: `node scripts/write-sha256.mjs`.
 * Sidecar format is standard sha256sum output: `<HEX>  <filename>` — verify on
 * Windows with `Get-FileHash .\MPI-X.Y.Z.exe -Algorithm SHA256` and compare.
 */

import { createHash } from "node:crypto";
import { createReadStream, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const releaseDir = join(fileURLToPath(new URL("..", import.meta.url)), "release");

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
    stream.on("error", reject);
  });
}

const files = readdirSync(releaseDir).filter((name) => name.toLowerCase().endsWith(".exe"));
if (files.length === 0) {
  console.warn("[write-sha256] no .exe found in release/ — nothing to do");
  process.exit(0);
}

for (const name of files.sort()) {
  const digest = await sha256File(join(releaseDir, name));
  const sidecar = join(releaseDir, `${name}.sha256`);
  // Standard two-space separator so `certutil`/PowerShell users can compare directly.
  writeFileSync(sidecar, `${digest}  ${name}\n`, "utf8");
  console.log(`[write-sha256] ${name}: ${digest}`);
}
