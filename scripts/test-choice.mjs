import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const logic = await import("../src/main/choice-logic.ts");
const renderer = await import("../src/renderer/src/lib/choice.ts");

// --- contract: heading prefix is recognized by BOTH sides -------------------
for (const lang of ["zh", "en"]) {
  const heading = logic.choiceHeading(lang, "用哪个实现方式？");
  assert.ok(logic.isChoiceTitle(heading), `main detects own heading (${lang})`);
  assert.ok(renderer.isChoiceTitle(heading), `renderer detects main heading (${lang})`);
  assert.equal(logic.stripChoicePrefix(heading), "用哪个实现方式？");
  assert.equal(renderer.stripChoicePrefix(heading), "用哪个实现方式？");
}

// Multi-line titles: only the first line carries the marker.
assert.ok(logic.isChoiceTitle("方案选择：问题\n详细说明行"));
assert.equal(renderer.stripChoicePrefix("Plan choice: Which one?\ndetail"), "Which one?");
assert.ok(!logic.isChoiceTitle("权限确认：Shell"));
assert.ok(!renderer.isChoiceTitle(undefined));

// --- contract: result texts round-trip through the renderer parser ----------
for (const lang of ["zh", "en"]) {
  const selected = logic.choiceResultText(lang, "方案B：markdown 约定");
  assert.deepEqual(renderer.parseChoiceOutcome(selected), { kind: "selected", value: "方案B：markdown 约定" });

  const cancelled = logic.choiceResultText(lang, null);
  assert.deepEqual(renderer.parseChoiceOutcome(cancelled), { kind: "cancelled" });
}
assert.equal(renderer.parseChoiceOutcome(undefined), null);
assert.equal(renderer.parseChoiceOutcome("some unrelated tool output"), null);

// --- renderer option normalization (string | {label, detail} | garbage) -----
assert.deepEqual(
  renderer.choiceOptions(["a", { label: "b", detail: " d " }, 42, null, "", { label: "" }]),
  [{ label: "a" }, { label: "b", detail: "d" }],
);
assert.deepEqual(renderer.choiceOptions("not an array"), []);
assert.deepEqual(renderer.choiceOption({ label: "x", detail: undefined }), { label: "x" });
// dedupe by label, first wins
assert.deepEqual(renderer.choiceOptions(["A", { label: "A", detail: "dup" }, "B"]), [{ label: "A" }, { label: "B" }]);

// --- real extension source against stubs (same pattern as channel-ext) ------
const root = mkdtempSync(join(tmpdir(), "mpi-choice-ext-"));
try {
  const extDir = join(root, "ext");
  mkdirSync(join(extDir, "node_modules", "typebox"), { recursive: true });
  writeFileSync(
    join(extDir, "node_modules", "typebox", "package.json"),
    JSON.stringify({ name: "typebox", main: "index.js" }),
  );
  writeFileSync(
    join(extDir, "node_modules", "typebox", "index.js"),
    "exports.Type = { Object: (o) => o, String: () => ({}), Array: (o) => o, Optional: (x) => x, Union: (a) => a[0] };\n",
  );
  const extPath = join(extDir, "ext.ts");
  copyFileSync("src/main/mpi-choice-ext.ts", extPath);

  // Language is read live from config.json on every call (like the gate).
  const configFile = join(root, "config.json");
  process.env.MPI_CHOICE_CONFIG = configFile;

  const tools = {};
  const extMod = await import(pathToFileURL(extPath).href);
  extMod.default({ registerTool: (def) => (tools[def.name] = def) });
  assert.deepEqual(Object.keys(tools), ["mpi_ask_choice"]);
  const tool = tools.mpi_ask_choice;
  assert.equal(tool.executionMode, "sequential");

  const textOf = (r) => r.content.find((b) => b.type === "text").text;
  let lastRequest = null;
  const ctxWithUi = (answer) => ({
    hasUI: true,
    mode: "rpc",
    ui: { select: async (title, options) => ((lastRequest = { title, options }), answer) },
  });

  // zh config → zh heading + zh result
  writeFileSync(configFile, JSON.stringify({ language: "zh" }));
  let out = await tool.execute("t1", { question: "用哪个实现方式？", options: ["方案A：扩展工具", "方案B：markdown"] }, undefined, undefined, ctxWithUi("方案B：markdown"));
  assert.ok(lastRequest.title.startsWith("方案选择："), lastRequest.title);
  assert.deepEqual(lastRequest.options, ["方案A：扩展工具", "方案B：markdown"]);
  assert.equal(textOf(out), '用户已选择：「方案B：markdown」。请按此选项继续执行。');

  // closed card → undefined → never pick on the user's behalf
  out = await tool.execute("t2", { question: "选哪个？", options: ["A", "B"] }, undefined, undefined, ctxWithUi(undefined));
  assert.ok(textOf(out).includes("未做出选择"), textOf(out));

  // en config → en heading + en result (live switch, no re-import)
  writeFileSync(configFile, JSON.stringify({ language: "en" }));
  out = await tool.execute("t3", { question: "Which approach?", options: ["Plan A", "Plan B"] }, undefined, undefined, ctxWithUi("Plan A"));
  assert.ok(lastRequest.title.startsWith("Plan choice:"), lastRequest.title);
  assert.equal(textOf(out), 'User selected: "Plan A". Proceed with this option.');

  // headless (no UI) → plain-text fallback listing the options
  out = await tool.execute(
    "t4",
    { question: "Which approach?", options: ["Plan A", "Plan B"] },
    undefined,
    undefined,
    { hasUI: false, mode: "print" },
  );
  assert.ok(textOf(out).includes("1. Plan A") && textOf(out).includes("2. Plan B"), textOf(out));

  // validation: fewer than two usable options → error, no dialog
  out = await tool.execute("t5", { question: "Q?", options: ["only one"] }, undefined, undefined, ctxWithUi("x"));
  assert.ok(textOf(out).startsWith("Error:"), textOf(out));

  // option labels are normalized (whitespace collapsed) before the dialog
  out = await tool.execute(
    "t6",
    { question: "Q?", options: ["  spaced   label ", "ok"] },
    undefined,
    undefined,
    ctxWithUi("spaced label"),
  );
  assert.deepEqual(lastRequest.options, ["spaced label", "ok"]);

  // object options {label, detail} pass through to select verbatim (RPC mode
  // forwards them intact); the result text uses only the label.
  out = await tool.execute(
    "t7",
    {
      question: "Q?",
      options: ["方案A：简单", { label: "方案B：完整", detail: "多 200 行代码，但支持 X" }],
    },
    undefined,
    undefined,
    ctxWithUi("方案B：完整"),
  );
  assert.deepEqual(lastRequest.options, [
    "方案A：简单",
    { label: "方案B：完整", detail: "多 200 行代码，但支持 X" },
  ]);
  // config is en at this point (set for t3) — template language follows config.
  assert.equal(textOf(out), 'User selected: "方案B：完整". Proceed with this option.');

  // detail is trimmed + capped; label whitespace collapsed inside objects too
  const longDetail = "x".repeat(1500);
  out = await tool.execute(
    "t8",
    { question: "Q?", options: [{ label: "  A  ", detail: ` ${longDetail} ` }, "B"] },
    undefined,
    undefined,
    ctxWithUi("A"),
  );
  assert.deepEqual(lastRequest.options[0], { label: "A", detail: longDetail.slice(0, 1200) });

  // headless fallback lists labels with inline details
  out = await tool.execute(
    "t9",
    { question: "Q?", options: [{ label: "A", detail: "why A" }, "B"] },
    undefined,
    undefined,
    { hasUI: false, mode: "print" },
  );
  assert.ok(textOf(out).includes("1. A — why A") && textOf(out).includes("2. B"), textOf(out));

  // duplicate labels are deduped (string + object with the same label)
  out = await tool.execute(
    "t10",
    { question: "Q?", options: ["A", { label: "A", detail: "dup" }, "B"] },
    undefined,
    undefined,
    ctxWithUi("A"),
  );
  assert.deepEqual(lastRequest.options, ["A", "B"]);
} finally {
  delete process.env.MPI_CHOICE_CONFIG;
  rmSync(root, { recursive: true, force: true });
}

console.log("choice tests passed");
