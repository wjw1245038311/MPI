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

// --- old-transcript parser: canonical result texts (mpi_ask_choice was removed;
// these strings remain in existing session history and ChoiceToolCard renders them)
assert.deepEqual(
  renderer.parseChoiceOutcome("用户已选择：「方案B：markdown 约定」。请按此选项继续执行。"),
  { kind: "selected", value: "方案B：markdown 约定" },
);
assert.deepEqual(renderer.parseChoiceOutcome('User selected: "Plan A". Proceed with this option.'), {
  kind: "selected",
  value: "Plan A",
});
assert.deepEqual(
  renderer.parseChoiceOutcome("用户未做出选择（对话框已关闭）。不要擅自选择任何方案；用文字询问用户想要哪个。"),
  { kind: "cancelled" },
);
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

// --- Q&A mode instruction (Settings → 对话设置 “问答方式”) -------------------
assert.ok(logic.qaModeInstruction("inline", "zh").includes("内联快速选择"));
assert.ok(logic.qaModeInstruction("inline", "zh").includes("我的选择："));
assert.ok(logic.qaModeInstruction("manual", "zh").startsWith("## 问答方式：手动回答"));
assert.ok(logic.qaModeInstruction("manual", "zh").includes("不要输出"));
assert.ok(logic.qaModeInstruction("inline", "en").includes("inline quick choice"));
assert.ok(logic.qaModeInstruction("manual", "en").includes("Do NOT emit"));

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
  assert.deepEqual(Object.keys(tools).sort(), ["mpi_request_mode_switch"]);

  const textOf = (r) => r.content.find((b) => b.type === "text").text;
  let lastRequest = null;
  const ctxWithUi = (answer) => ({
    hasUI: true,
    mode: "rpc",
    ui: { select: async (title, options) => ((lastRequest = { title, options }), answer) },
  });

  let out;
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
