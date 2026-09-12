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
  assert.deepEqual(Object.keys(tools).sort(), ["mpi_ask_choice", "mpi_request_mode_switch"]);
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

  // ---- mpi_request_mode_switch (contract with ipc.ts / choice-logic.ts) -----
  const switchTool = tools.mpi_request_mode_switch;
  assert.equal(switchTool.executionMode, "sequential");

  // invalid target level → error, no dialog
  out = await switchTool.execute("s1", { to: "hacked", reason: "r" }, undefined, undefined, ctxWithUi("x"));
  assert.ok(textOf(out).startsWith("Error:"), textOf(out));

  // zh config → stable prefix + fixed option labels (main matches them exactly)
  writeFileSync(configFile, JSON.stringify({ language: "zh" }));
  out = await switchTool.execute(
    "s2",
    { to: "sandbox", reason: "按调研方案部署语音模块" },
    undefined,
    undefined,
    ctxWithUi("同意并切换"),
  );
  assert.ok(lastRequest.title.startsWith("模式切换请求："), lastRequest.title);
  assert.ok(lastRequest.title.includes("切换到「沙盒」权限"), lastRequest.title);
  assert.deepEqual(lastRequest.options, ["同意并切换", "拒绝"]);
  assert.ok(textOf(out).includes("已同意") && textOf(out).includes("继续执行方案"), textOf(out));

  // denied → stay read-only guidance
  out = await switchTool.execute("s3", { to: "full", reason: "r" }, undefined, undefined, ctxWithUi("拒绝"));
  assert.ok(textOf(out).includes("拒绝了") && textOf(out).includes("不要尝试任何写操作"), textOf(out));

  // closed card → never assume approval
  out = await switchTool.execute("s4", { to: "sandbox", reason: "r" }, undefined, undefined, ctxWithUi(undefined));
  assert.ok(textOf(out).includes("未做出选择") && textOf(out).includes("不要擅自假设"), textOf(out));

  // en config → en heading + labels (main matches both languages)
  writeFileSync(configFile, JSON.stringify({ language: "en" }));
  out = await switchTool.execute(
    "s5",
    { to: "full", reason: "deploy per plan" },
    undefined,
    undefined,
    ctxWithUi("Approve & switch"),
  );
  assert.ok(lastRequest.title.startsWith("Mode switch request:"), lastRequest.title);
  assert.ok(lastRequest.title.includes('switch to "Full access"'), lastRequest.title);
  assert.deepEqual(lastRequest.options, ["Approve & switch", "Deny"]);
  assert.ok(textOf(out).includes("approved"), textOf(out));

  // headless → tell the user how to switch manually instead of a dialog
  out = await switchTool.execute(
    "s6",
    { to: "sandbox", reason: "r" },
    undefined,
    undefined,
    { hasUI: false, mode: "print" },
  );
  assert.ok(textOf(out).includes("No interactive UI"), textOf(out));

  // main-side recognition (choice-logic) matches what the extension writes
  writeFileSync(configFile, JSON.stringify({ language: "zh" }));
  await switchTool.execute("s7", { to: "sandbox", reason: "r" }, undefined, undefined, ctxWithUi(undefined));
  assert.ok(logic.isModeSwitchTitle(lastRequest.title), lastRequest.title);
  writeFileSync(configFile, JSON.stringify({ language: "en" }));
  await switchTool.execute("s8", { to: "sandbox", reason: "r" }, undefined, undefined, ctxWithUi(undefined));
  assert.ok(logic.isModeSwitchTitle(lastRequest.title), lastRequest.title);

  // F1: on approval the extension restores write/edit visibility immediately —
  // but only once the enforced floor is actually lifted (main deletes the state
  // file right after responding to us; any ordering race must not restore early).
  {
    const stateDir = mkdtempSync(join(tmpdir(), "mpi-choice-state-"));
    try {
      process.env.MPI_TASKMODE_DIR = stateDir;
      writeFileSync(configFile, JSON.stringify({ language: "zh" })); // s8 left it en
      const activeTools = ["read", "bash"]; // write/edit hidden while enforced
      const tools2 = {};
      extMod.default({
        registerTool: (def) => {
          tools2[def.name] = def;
        },
        getActiveTools: () => [...activeTools],
        setActiveTools(names) {
          activeTools.length = 0;
          activeTools.push(...names);
        },
      });
      const switchTool2 = tools2.mpi_request_mode_switch;
      const ctxSwitch = (answer, sessionFile) => ({
        ...ctxWithUi(answer),
        sessionManager: { getSessionFile: () => sessionFile },
      });

      // state file still says enforce=readonly → approval must NOT restore yet
      writeFileSync(join(stateDir, "aaa.json"), JSON.stringify({ instructions: "x", enforce: "readonly" }));
      await switchTool2.execute("f1", { to: "sandbox", reason: "r" }, undefined, undefined, ctxSwitch("同意并切换", "proj_aaa.jsonl"));
      assert.deepEqual(activeTools, ["read", "bash"], "no restore while state file still enforces");

      // main deleted the state file → approval restores write/edit immediately
      rmSync(join(stateDir, "aaa.json"), { force: true });
      await switchTool2.execute("f2", { to: "sandbox", reason: "r" }, undefined, undefined, ctxSwitch("同意并切换", "proj_aaa.jsonl"));
      assert.deepEqual([...activeTools].sort(), ["bash", "edit", "read", "write"], "restored on approval once unenforced");

      // denial never restores
      activeTools.length = 0;
      activeTools.push("read", "bash");
      await switchTool2.execute("f3", { to: "sandbox", reason: "r" }, undefined, undefined, ctxSwitch("拒绝", "proj_aaa.jsonl"));
      assert.deepEqual(activeTools, ["read", "bash"], "denial leaves tools hidden");
    } finally {
      delete process.env.MPI_TASKMODE_DIR;
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
} finally {
  delete process.env.MPI_CHOICE_CONFIG;
  rmSync(root, { recursive: true, force: true });
}

console.log("choice tests passed");
