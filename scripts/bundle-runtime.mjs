#!/usr/bin/env node
/**
 * Build the standalone MPI runtime asset.
 *
 * This script creates the versioned Node.js + Pi archive that electron-builder
 * embeds in the desktop installer and writes its integrity manifest into
 * resources/. All pruning is implemented with Node's filesystem APIs so it is
 * deterministic on Windows (where `find` is not GNU find and `rm` is absent).
 */

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const EXPECTED_PI_VERSION = process.env.PI_RUNTIME_VERSION || APP_PACKAGE.piRuntimeVersion || "0.84.1";
const STAGE = join(ROOT, ".runtime-stage");
const RUNTIME_OUT = join(ROOT, "runtime-release");
const MANIFEST_OUT = join(ROOT, "resources", "runtime-manifest.json");
const PLATFORM_SLUGS = { win32: "win", darwin: "mac" };
const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

function log(message) {
  console.log(`[bundle-runtime] ${message}`);
}

function nodeExe() {
  return process.platform === "win32" ? "node.exe" : "node";
}

function tarBinary() {
  if (process.platform === "win32") return join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return "tar";
}

function npmBinary() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function directoryStats(root) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        files++;
        try {
          bytes += statSync(abs).size;
        } catch {
          /* best effort stats only */
        }
      }
    }
  };
  walk(root);
  return { files, bytes };
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function pruneTree(root) {
  const removableDirs = new Set([
    ".github",
    "__mocks__",
    "__tests__",
    "benchmark",
    "benchmarks",
    "coverage",
    "docs",
    "example",
    "examples",
    "test",
    "tests",
  ]);

  const shouldRemoveFile = (name) =>
    /\.(?:map|d\.ts|d\.mts|d\.cts|ts|mts|cts)$/i.test(name) ||
    /^(?:README|CHANGELOG|HISTORY|CONTRIBUTING)(?:\.(?:md|markdown|txt|rst)|$)/i.test(name);

  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "@types" || removableDirs.has(entry.name)) {
          rmSync(abs, { recursive: true, force: true });
          continue;
        }
        walk(abs);
      } else if (entry.isFile() && shouldRemoveFile(entry.name)) {
        rmSync(abs, { force: true });
      }
    }
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a concurrent scanner may briefly hold the directory */
    }
  };

  walk(root);
}

/** pi ≥0.85 depends on @earendil-works/chord, which declares esbuild; npm then
 * installs platform binaries for ~20 platforms (~270MB) even though pi only uses
 * chord/context and never bundles at runtime. Keep just the current platform's
 * binary so a future bundler call still works on this machine. */
function pruneEsbuildPlatforms(root) {
  const scope = join(root, "node_modules", "@esbuild");
  if (!existsSync(scope)) return;
  const keep = `${process.platform}-${process.arch}`; // e.g., win32-x64 / darwin-arm64
  let removedBytes = 0;
  for (const entry of readdirSync(scope, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === keep) continue;
    const abs = join(scope, entry.name);
    try {
      removedBytes += directoryStats(abs).bytes;
      rmSync(abs, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  if (removedBytes > 0) log(`pruned @esbuild platform binaries except ${keep}: -${formatSize(removedBytes)}`);
}

/** pi 依赖 @mariozechner/clipboard：npm 会把各平台的原生二进制一起装上
 * （darwin-universal/x64/arm64、linux-x64/arm64/riscv64、win32-arm64 等，约 10MB），
 * 而本机只可能加载当前平台那一份。只留当前平台的，其余删掉。
 * 注意：不带平台后缀的 `@mariozechner/clipboard`（JS 包装层）要保留。 */
function pruneClipboardPlatforms(root) {
  const scope = join(root, "node_modules", "@mariozechner");
  if (!existsSync(scope)) return;
  const keepPrefix =
    process.platform === "win32"
      ? `clipboard-win32-${process.arch}`
      : process.platform === "darwin"
        ? "clipboard-darwin"
        : `clipboard-linux-${process.arch}`;
  let removedBytes = 0;
  for (const entry of readdirSync(scope, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("clipboard-")) continue; // JS 包装层保留
    if (entry.name.startsWith(keepPrefix)) continue;
    const abs = join(scope, entry.name);
    try {
      removedBytes += directoryStats(abs).bytes;
      rmSync(abs, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  if (removedBytes > 0) log(`pruned clipboard binaries except ${keepPrefix}: -${formatSize(removedBytes)}`);
}

function readPiVersion(dir) {
  try {
    const packageJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}

function isExpectedPiPackage(dir) {
  return existsSync(join(dir, "dist", "cli.js")) && readPiVersion(dir) === EXPECTED_PI_VERSION;
}

function locatePiPackage() {
  const explicit = process.env.PI_PACKAGE_DIR?.trim();
  if (explicit) {
    if (isExpectedPiPackage(explicit)) return explicit;
    const actualVersion = readPiVersion(explicit) || "unknown";
    throw new Error(`PI_PACKAGE_DIR must contain Pi v${EXPECTED_PI_VERSION}; found v${actualVersion}: ${explicit}`);
  }

  try {
    // shell:true is required on Windows: Node refuses to spawn .cmd shims directly (EINVAL).
    const globalRoot = execFileSync(npmBinary(), ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true }).trim();
    const globalPackage = join(globalRoot, "@earendil-works", "pi-coding-agent");
    if (isExpectedPiPackage(globalPackage)) return globalPackage;
  } catch {
    /* fall through to PATH scan */
  }

  const pathDirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of pathDirs) {
    const shim = join(dir, process.platform === "win32" ? "pi.cmd" : "pi");
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(shim) && isExpectedPiPackage(candidate)) return candidate;
  }
  return null;
}

function bundleNode() {
  const dest = join(STAGE, "node", nodeExe());
  mkdirSync(dirname(dest), { recursive: true });
  log(`copying Node.js: ${process.execPath} -> ${dest}`);
  cpSync(process.execPath, dest);
  if (process.platform !== "win32") {
    chmodSync(dest, statSync(process.execPath).mode & 0o777);
  }
}

/**
 * Locate the npm package tree that ships alongside the Node.js binary used for
 * the build. Official installs keep it next to node.exe (Windows) or under
 * <prefix>/lib/node_modules (macOS).
 */
function npmSourceDir() {
  const nodeDir = dirname(process.execPath);
  const candidates =
    process.platform === "win32"
      ? [join(nodeDir, "node_modules", "npm")]
      : [join(nodeDir, "..", "lib", "node_modules", "npm"), join(nodeDir, "node_modules", "npm")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "bin", "npm-cli.js"))) return candidate;
  }
  throw new Error(`Could not locate the npm package tree next to ${process.execPath}`);
}

/**
 * Bundle the npm CLI into the runtime so `pi install` works on machines that
 * have no Node.js/npm of their own. MPI points Pi's `npmCommand` setting at
 * <root>/node/node(.exe) + <root>/npm/node_modules/npm/bin/npm-cli.js.
 */
function bundleNpm() {
  const source = npmSourceDir();
  const dest = join(STAGE, "npm", "node_modules", "npm");
  mkdirSync(dirname(dest), { recursive: true });
  log(`copying npm CLI from ${source} -> ${dest}`);
  cpSync(source, dest, { recursive: true });
  // Prune documentation only (never the source tree): npm's install path does
  // not read docs/ or man/ at runtime.
  for (const name of ["docs", "man", ".github"]) {
    rmSync(join(dest, name), { recursive: true, force: true });
  }
  if (!existsSync(join(dest, "bin", "npm-cli.js"))) throw new Error("bundled npm is missing bin/npm-cli.js");
  log(`bundled npm CLI: ${directoryStats(dest).files} files/${formatSize(directoryStats(dest).bytes)}`);
}

function bundlePi(source) {
  const destination = join(STAGE, "pi");
  mkdirSync(destination, { recursive: true });
  log(`copying pi dist and dependencies from ${source}`);
  cpSync(join(source, "dist"), join(destination, "dist"), { recursive: true });
  cpSync(join(source, "node_modules"), join(destination, "node_modules"), { recursive: true });
  cpSync(join(source, "package.json"), join(destination, "package.json"));

  const before = directoryStats(destination);
  pruneTree(destination);
  pruneEsbuildPlatforms(destination);
  pruneClipboardPlatforms(destination);
  const after = directoryStats(destination);
  log(`pruned pi runtime: ${before.files} files/${formatSize(before.bytes)} -> ${after.files} files/${formatSize(after.bytes)}`);

  const packageJson = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || !packageJson.version) throw new Error("pi package has no version");
  return packageJson.version;
}

function sha512Base64(file) {
  const hash = createHash("sha512");
  hash.update(readFileSync(file));
  return hash.digest("base64");
}

function main() {
  const platformSlug = PLATFORM_SLUGS[process.platform];
  if (!platformSlug || !SUPPORTED_ARCHES.has(process.arch)) {
    throw new Error(`Unsupported standalone runtime target: ${process.platform}/${process.arch}. Use Windows or macOS on x64 or arm64.`);
  }

  const source = locatePiPackage();
  if (!source) {
    throw new Error(`Could not locate @earendil-works/pi-coding-agent v${EXPECTED_PI_VERSION}. Set PI_PACKAGE_DIR to a matching package or install that version globally.`);
  }

  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  rmSync(RUNTIME_OUT, { recursive: true, force: true });
  mkdirSync(RUNTIME_OUT, { recursive: true });
  bundleNode();
  bundleNpm();
  const runtimeVersion = bundlePi(source);
  if (runtimeVersion !== EXPECTED_PI_VERSION) {
    throw new Error(`Pi runtime version mismatch: expected v${EXPECTED_PI_VERSION}, found v${runtimeVersion}`);
  }
  const fileName = `MPI-Runtime-${runtimeVersion}-${platformSlug}-${process.arch}.tar.gz`;
  const archive = join(RUNTIME_OUT, fileName);
  rmSync(archive, { force: true });

  log(`creating archive ${archive}`);
  execFileSync(tarBinary(), ["-czf", archive, "-C", STAGE, "."], { stdio: "inherit" });
  const size = statSync(archive).size;
  const manifest = {
    schema: 2,
    embedded: true,
    runtimeVersion,
    platform: process.platform,
    arch: process.arch,
    fileName,
    size,
    sha512: sha512Base64(archive),
  };
  mkdirSync(dirname(MANIFEST_OUT), { recursive: true });
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  log(`runtime asset: ${fileName} (${formatSize(size)})`);
  log(`manifest: ${MANIFEST_OUT}`);
  log("done.");
}

try {
  main();
} finally {
  rmSync(STAGE, { recursive: true, force: true });
}
