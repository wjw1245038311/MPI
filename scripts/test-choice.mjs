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
// skills that prescribe their own question format are out of scope: 列举例举不尽，
// 只保证「正常使用」（用户决策 / 下一步）这个主场景，不写冲突消解规则。
assert.ok(logic.qaModeInstruction("inline", "en").includes("inline quick choice"));
assert.ok(logic.qaModeInstruction("manual", "en").includes("Do NOT emit"));
// format hard rule: the closing fence must sit on its own line (a glued ``` silently
// kills the panel — the renderer falls back to a plain code block)
assert.ok(logic.qaModeInstruction("inline", "zh").includes("独占一行"));
assert.ok(logic.qaModeInstruction("inline", "en").includes("own line"));
// 2026-10-27：模型在同一条回复里写两个 choices 块（先草稿后重写），两份都渲染成面板。
// 提示词现在把「只写一个块 / 不要草稿块」写成硬约束，防止口径回退。
assert.ok(logic.qaModeInstruction("inline", "zh").includes("一条回复最多一个块"));
assert.ok(logic.qaModeInstruction("inline", "zh").includes("草稿块"));
assert.ok(logic.qaModeInstruction("inline", "zh").includes("```choices>"));
assert.ok(logic.qaModeInstruction("inline", "en").includes("At most ONE block per reply"));
assert.ok(logic.qaModeInstruction("inline", "en").includes("draft block"));
// 2026-10-30 minibox 现场（session-01a1885c）：模型把「等你对第 4 条的意见」写成正文收尾，
// 用户 7 小时后回来问「怎么结束了」。提示词现在把「阻塞决策必须走面板」写成硬约束。
assert.ok(logic.qaModeInstruction("inline", "zh").includes("用 choices 围栏收尾"));
assert.ok(logic.qaModeInstruction("inline", "zh").includes("多选问答"));
assert.ok(logic.qaModeInstruction("inline", "zh").includes("不要用正文问句收尾"));
assert.ok(logic.qaModeInstruction("inline", "en").includes("end with a choices fence"));
assert.ok(logic.qaModeInstruction("inline", "en").includes("multi-choice question"));
assert.ok(logic.qaModeInstruction("inline", "en").includes("never with a bare open-ended question"));
assert.ok(logic.qaModeInstruction("manual", "zh").includes("等你回答后我继续"));
assert.ok(logic.qaModeInstruction("manual", "en").includes("I will continue once you answer"));
// 提示词本身是上下文负担：越长越容易被长上下文淡化。2026-10-30 从 23 行压到 13 行，
// 这里给个上限防反弹（加规则时先删旧的，而不是一路追加）。
assert.ok(
  logic.qaModeInstruction("inline", "zh").split("\n").length <= 16,
  `内联提示词不应超过 16 行，当前 ${logic.qaModeInstruction("inline", "zh").split("\n").length} 行`,
);
assert.ok(
  logic.qaModeInstruction("inline", "en").split("\n").length <= 16,
  `EN inline prompt should stay <= 16 lines`,
);

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

// --- 反漂移：三端「发送选择」都必须有在途守卫 -----------------------------
// frozen 要等新 user 消息回灌才变真，这段空窗里按钮仍可点 —— 双击/连点=
// 同一份选择发两次（2026-10-26 真机实测：桌面端漏了这个守卫，PWA/安卓有）。
{
  const { readFileSync } = await import("node:fs");
  const desktop = readFileSync(new URL("../src/renderer/src/components/ChoicePanel.tsx", import.meta.url), "utf8");
  const pwa = readFileSync(new URL("../mobile/pwa/src/components/ChoicePanel.tsx", import.meta.url), "utf8");
  assert.match(desktop, /if \(frozen \|\| sending\) return;/, "桌面端 submit 必须拦在途重复提交");
  assert.match(desktop, /setSending\(true\)/, "桌面端必须有 sending 状态");
  assert.match(pwa, /if \(frozen \|\| sending\) return;/, "PWA submit 必须拦在途重复提交");
}

console.log("choice tests passed");
