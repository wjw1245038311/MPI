import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig } = await import("../src/main/config.ts");
const { customCssPath, ensureCustomCssTemplate, readCustomCss, watchCustomCss } = await import(
  "../src/main/custom-css.ts"
);

// Point config (and thus custom.css) at a throwaway userData dir.
const dir = mkdtempSync(join(tmpdir(), "mpi-customcss-"));
loadConfig(dir);

// 1) Missing file -> empty content, path under the userData dir.
assert.equal(readCustomCss(), "", "no file: empty content");
assert.ok(customCssPath().startsWith(dir), "path lives in the profile's userData dir");

// 2) First ensure creates the annotated template (zh).
let r = ensureCustomCssTemplate("zh");
assert.equal(r.created, true, "first call creates the file");
assert.ok(existsSync(r.path));
const zhTpl = readFileSync(r.path, "utf8");
assert.match(zhTpl, /自定义样式表/, "zh template header");
assert.match(zhTpl, /--accent/, "template documents theme variables");

// 3) Second ensure never overwrites; user edits survive.
writeFileSync(r.path, "body { color: red; }", "utf8");
r = ensureCustomCssTemplate("en");
assert.equal(r.created, false, "existing file is not recreated");
assert.equal(readCustomCss(), "body { color: red; }", "user edits are preserved");

// 4) readCustomCss reflects live content.
writeFileSync(r.path, "/* v2 */\n.msg { margin: 0; }", "utf8");
assert.match(readCustomCss(), /v2/);

// 5) Watcher fires on edit (debounced), and ignores other files in the dir.
const events = [];
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("watch timeout: no change event")), 4000);
  const stop = watchCustomCss(() => {
    clearTimeout(t);
    stop();
    resolve();
  });
  events.push("edit");
  writeFileSync(r.path, "/* v3 */", "utf8");
});
assert.deepEqual(events, ["edit"]);

// Other files in the same dir must NOT trigger a callback.
await new Promise((resolve) => {
  let fired = false;
  const t = setTimeout(() => resolve(), 600); // wait past the debounce window
  const stop = watchCustomCss(() => {
    fired = true;
    clearTimeout(t);
    stop();
    resolve();
  });
  writeFileSync(join(dir, "config.json"), "{}", "utf8");
  assert.equal(fired, false, "unrelated file change must not fire the watcher");
});

// 6) Deleting the file also fires (renderer clears the <style> tag).
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("watch timeout: no delete event")), 4000);
  const stop = watchCustomCss(() => {
    clearTimeout(t);
    stop();
    resolve();
  });
  rmSync(r.path);
});
assert.equal(readCustomCss(), "", "deleted file reads back empty");

console.log("custom-css: all assertions passed");
