// Bundles scripts/.tui-race-entry.ts (re-exports src/main/tui + loadConfig,
// with the local import chain) into a CJS file that scripts/test-tui-race.cjs
// can require under plain node. `electron` stays external — the test redirects
// it to a stub via a require hook.
import { buildSync } from "esbuild";

buildSync({
  entryPoints: ["scripts/.tui-race-entry.ts"],
  bundle: true,
  platform: "node",
  // node-pty must stay a runtime require — its prebuilt .node files resolve
  // relative to the package's own lib/ dir, which bundling would break.
  external: ["electron", "node-pty"],
  format: "cjs",
  outfile: "scripts/.tui-race-bundle.cjs",
  logLevel: "warning",
});
console.log("[tui-race] bundle written to scripts/.tui-race-bundle.cjs");
