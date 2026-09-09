import assert from "node:assert/strict";
import { decideNpmCommand, isManagedNpmCommand, classifyMissingTool } from "../src/main/npm-command.ts";

const BASE = "C:\\Users\\wei\\AppData\\Roaming\\MPI\\runtime";
const NODE = `${BASE}\\versions\\0.85.1\\node\\node.exe`;
const NPM_CLI = `${BASE}\\versions\\0.85.1\\npm\\node_modules\\npm\\bin\\npm-cli.js`;

// --- decideNpmCommand: runtime without bundled npm ---------------------------
assert.deepEqual(
  decideNpmCommand({ settings: {}, nodePath: NODE, bundledNpmCli: null, runtimeBase: BASE }),
  { action: "noop" },
); // nothing to do when no one configured anything

assert.deepEqual(
  decideNpmCommand({
    settings: { npmCommand: ["C:\\Users\\wei\\AppData\\Roaming\\MPI\\runtime\\versions\\0.84.0\\node\\node.exe", "old-cli.js"] },
    nodePath: NODE,
    bundledNpmCli: null,
    runtimeBase: BASE,
  }),
  { action: "clear" },
); // stale managed value (previous pi version dir was pruned) must be cleared

assert.deepEqual(
  decideNpmCommand({ settings: { npmCommand: ["mise", "exec", "node@20", "--", "npm"] }, nodePath: NODE, bundledNpmCli: null, runtimeBase: BASE }),
  { action: "noop" },
); // user-configured wrapper is respected

// --- decideNpmCommand: runtime with bundled npm ------------------------------
assert.deepEqual(
  decideNpmCommand({ settings: {}, nodePath: NODE, bundledNpmCli: NPM_CLI, runtimeBase: BASE }),
  { action: "write", value: [NODE, NPM_CLI] },
); // first run: point pi at the bundled npm

assert.deepEqual(
  decideNpmCommand({ settings: { npmCommand: [NODE, NPM_CLI] }, nodePath: NODE, bundledNpmCli: NPM_CLI, runtimeBase: BASE }),
  { action: "noop" },
); // already correct — no write churn

assert.deepEqual(
  decideNpmCommand({
    settings: { npmCommand: ["C:\\Users\\wei\\AppData\\Roaming\\MPI\\runtime\\versions\\0.84.0\\node\\node.exe", "old-cli.js"] },
    nodePath: NODE,
    bundledNpmCli: NPM_CLI,
    runtimeBase: BASE,
  }),
  { action: "write", value: [NODE, NPM_CLI] },
); // stale managed value is replaced after a pi update

assert.deepEqual(
  decideNpmCommand({ settings: { npmCommand: ["C:\\Program Files\\nodejs\\npm.cmd"] }, nodePath: NODE, bundledNpmCli: NPM_CLI, runtimeBase: BASE }),
  { action: "noop" },
); // user explicitly pinned their own npm — never override

// --- isManagedNpmCommand ------------------------------------------------------
assert.equal(isManagedNpmCommand(["c:/users/wei/appdata/roaming/MPI/runtime/x/node.exe"], BASE), true); // case + slash insensitive
assert.equal(isManagedNpmCommand([`${BASE}\\node\\node.exe`], BASE), true);
assert.equal(isManagedNpmCommand(["C:\\Program Files\\nodejs\\npm.cmd"], BASE), false);
assert.equal(isManagedNpmCommand("npm", BASE), false); // not an array
assert.equal(isManagedNpmCommand([], BASE), false);
assert.equal(isManagedNpmCommand([42], BASE), false);

// --- classifyMissingTool -------------------------------------------------------
assert.equal(classifyMissingTool("Installing npm:left-pad...\nError: spawn npm ENOENT"), "npm");
assert.equal(classifyMissingTool("spawn npx ENOENT"), "npm");
assert.equal(classifyMissingTool("Cloning repo...\nError: spawn git ENOENT"), "git");
assert.equal(classifyMissingTool("npm ERR! code E404\nnpm ERR! 404 Not Found"), null); // registry error, not missing tool
assert.equal(classifyMissingTool(""), null);

console.log("npm-command tests passed");
