import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig } = await import("../src/main/config.ts");

// Simulate %APPDATA% with the two known sibling profiles.
const appData = mkdtempSync(join(tmpdir(), "mpi-appdata-"));
const prodDir = join(appData, "MPI");
const devDir = join(appData, "MPI Dev");
mkdirSync(prodDir);
mkdirSync(devDir);

// 1) Fresh profile with no sibling config -> pure defaults.
let cfg = loadConfig(devDir);
assert.equal(cfg.language, "en", "no sibling config: default language en");
assert.equal(cfg.theme, "light", "no sibling config: default theme light");

// 2) Prod has zh/dark; fresh dev profile inherits both on first load.
writeFileSync(join(prodDir, "config.json"), JSON.stringify({ language: "zh", theme: "dark" }));
cfg = loadConfig(devDir);
assert.equal(cfg.language, "zh", "inherits language from sibling");
assert.equal(cfg.theme, "dark", "inherits theme from sibling");

// 3) An existing own config is never overridden by the sibling.
writeFileSync(join(devDir, "config.json"), JSON.stringify({ language: "en", theme: "system" }));
cfg = loadConfig(devDir);
assert.equal(cfg.language, "en", "own config wins over sibling (language)");
assert.equal(cfg.theme, "system", "own config wins over sibling (theme)");

// 4) Corrupt own file -> fall back to defaults + sibling inheritance.
writeFileSync(join(devDir, "config.json"), "{not json");
cfg = loadConfig(devDir);
assert.equal(cfg.language, "zh", "corrupt own file: inherit from sibling");
assert.equal(cfg.theme, "dark", "corrupt own file: inherit theme too");

// 5) Sibling with invalid values is ignored (defaults kept).
rmSync(join(devDir, "config.json"));
writeFileSync(join(prodDir, "config.json"), JSON.stringify({ language: "fr", theme: "neon" }));
cfg = loadConfig(devDir);
assert.equal(cfg.language, "en", "invalid sibling language ignored");
assert.equal(cfg.theme, "light", "invalid sibling theme ignored");

// 6) Corrupt sibling -> skipped silently.
writeFileSync(join(prodDir, "config.json"), "{broken");
cfg = loadConfig(devDir);
assert.equal(cfg.language, "en", "corrupt sibling ignored");

// 7) Reverse direction: fresh prod inherits from an existing dev profile.
rmSync(join(prodDir, "config.json"));
writeFileSync(join(devDir, "config.json"), JSON.stringify({ language: "zh", theme: "dark" }));
cfg = loadConfig(prodDir);
assert.equal(cfg.language, "zh", "prod inherits from dev profile");
assert.equal(cfg.theme, "dark", "prod inherits theme from dev profile");

console.log("config-inherit: all assertions passed");
