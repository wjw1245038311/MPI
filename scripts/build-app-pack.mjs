#!/usr/bin/env node
/**
 * Build a self-contained MPI app package (zip) from a developer app source dir.
 *
 *   node scripts/build-app-pack.mjs --app=examples/apps/local-voice
 *
 * The staging package contains the app source + a vendored `runtime/`
 * (sherpa-onnx-node for the current platform) + a `model/` (speech model +
 * model.json descriptor). The result is a `<id>-<platform>-<arch>.zip` that the
 * App Store can install with “从 zip 安装”. App payloads are developer products
 * and are NEVER bundled inside the MPI installer.
 *
 * Options:
 *   --app=<dir>            app source dir (required)
 *   --out=<path>           output zip path (default: <id>-<platform>-<arch>.zip in cwd)
 *   --model=<key>          sensevoice (default) | paraformer-small
 *   --model-dir=<dir>      reuse an already-extracted model dir (skips download)
 *   --runtime-dir=<dir>    reuse an existing node_modules runtime (skips npm install)
 *   --runtime-version=<v>  sherpa-onnx-node version (default: latest)
 *   --mirror=<url>         URL prefix for GitHub downloads (e.g. https://ghproxy.com/)
 *   --keep                 keep the staging dir instead of deleting it
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

/** Bundled model presets. */
const MODELS = {
  sensevoice: {
    archive: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2",
    descriptor: { type: "senseVoice", model: "model.int8.onnx", tokens: "tokens.txt", name: "SenseVoiceSmall", language: "auto", useInverseTextNormalization: true },
  },
  "paraformer-small": {
    archive: "sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2",
    descriptor: { type: "paraformer", model: "model.int8.onnx", tokens: "tokens.txt", name: "paraformer-zh-small" },
  },
};

function parseArgs(argv) {
  const args = { model: "sensevoice", keep: false };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, key, val] = m;
    if (key === "keep") args.keep = true;
    else args[key] = val ?? "";
  }
  if (!args.app) {
    console.error("usage: node scripts/build-app-pack.mjs --app=<dir> [--model=sensevoice|paraformer-small] [--model-dir=...] [--runtime-dir=...] [--out=...] [--mirror=...]");
    process.exit(2);
  }
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: false, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} exited with ${r.status}`);
}

function mirrorUrl(url, mirror) {
  if (!mirror) return url;
  const base = mirror.endsWith("/") ? mirror : mirror + "/";
  return base + url;
}

/** Copy app source, excluding build artifacts and vendored payloads. */
const SKIP_DIRS = new Set(["runtime", "model", "node_modules", ".git", "dist", "out"]);

function copySource(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      const name = basename(from);
      if (SKIP_DIRS.has(name)) return false;
      if (name.endsWith(".zip")) return false;
      return true;
    },
  });
}

function installRuntime(staging, args) {
  const runtimeDir = join(staging, "runtime");
  if (args["runtime-dir"]) {
    const src = resolve(args["runtime-dir"]);
    if (!existsSync(src)) throw new Error(`--runtime-dir not found: ${src}`);
    // Copy into runtime/node_modules so the layout matches the npm path.
    cpSync(src, join(runtimeDir, "node_modules"), { recursive: true });
    return;
  }
  mkdirSync(runtimeDir, { recursive: true });
  const pkg = args["runtime-version"] ? `sherpa-onnx-node@${args["runtime-version"]}` : "sherpa-onnx-node";
  console.log(`[pack] installing runtime (${pkg}) into staging/runtime …`);
  // --prefix installs into <dir>/node_modules; omit dev deps to stay small.
  run("npm", ["install", "--prefix", runtimeDir, "--no-save", "--omit=dev", "--no-package-lock", pkg], {
    shell: process.platform === "win32",
    cwd: REPO,
  });
}

async function download(url, dest) {
  console.log(`[pack] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  console.log(`[pack] saved ${(buf.length / 1048576).toFixed(1)} MB -> ${dest}`);
}

async function installModel(staging, args) {
  const modelDir = join(staging, "model");
  mkdirSync(modelDir, { recursive: true });
  const preset = MODELS[args.model];
  if (!preset) throw new Error(`unknown --model="${args.model}" (known: ${Object.keys(MODELS).join(", ")})`);

  if (args["model-dir"]) {
    const src = resolve(args["model-dir"]);
    if (!existsSync(src)) throw new Error(`--model-dir not found: ${src}`);
    console.log(`[pack] copying model from ${src}`);
    cpSync(src, modelDir, { recursive: true });
  } else {
    const cacheDir = join(REPO, "tmp", "app-pack-cache");
    mkdirSync(cacheDir, { recursive: true });
    const archivePath = join(cacheDir, preset.archive);
    if (!existsSync(archivePath)) await download(mirrorUrl(`${RELEASE}/${preset.archive}`, args.mirror), archivePath);
    console.log(`[pack] extracting ${preset.archive} …`);
    run("tar", ["-xjf", archivePath, "-C", modelDir, "--strip-components=1"], { shell: process.platform === "win32" });
  }
  writeFileSync(join(modelDir, "model.json"), JSON.stringify(preset.descriptor, null, 2));
}

/** Zip the staging dir with the system bsdtar (constant memory, no dep). */
function zipDir(staging, outZip) {
  const top = readdirSync(staging);
  mkdirSync(dirname(outZip), { recursive: true });
  rmSync(outZip, { force: true });
  console.log(`[pack] writing ${outZip}`);
  run("tar", ["-a", "-cf", outZip, "-C", staging, ...top], { shell: process.platform === "win32" });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = resolve(args.app);
  const manifestPath = join(app, "mpi-app.json");
  if (!existsSync(manifestPath)) throw new Error(`not an app source dir (mpi-app.json missing): ${app}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const id = manifest.id;
  if (!id) throw new Error("manifest.id is required");

  const platform = `${process.platform}-${process.arch}`;
  const outZip = args.out ? resolve(args.out) : join(REPO, `${id}-${platform}.zip`);
  const staging = join(REPO, "tmp", `app-pack-${id}`);

  console.log(`[pack] app=${id} v${manifest.version} platform=${platform}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    copySource(app, staging);
    installRuntime(staging, args);
    await installModel(staging, args);
    zipDir(staging, outZip);
    const mb = (statSync(outZip).size / 1048576).toFixed(1);
    console.log(`\n[pack] done: ${outZip} (${mb} MB)`);
    console.log("[pack] install it in MPI → 应用商店 → 从 zip 安装");
  } finally {
    if (!args.keep) rmSync(staging, { recursive: true, force: true });
    else console.log(`[pack] staging kept at ${staging}`);
  }
}

main().catch((e) => {
  console.error("[pack] FAILED:", e?.message || e);
  process.exit(1);
});
