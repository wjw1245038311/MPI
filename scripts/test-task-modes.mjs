import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const tm = await import("../src/renderer/src/lib/task-modes.ts");

// “default” is the baseline mode: first in the list, no params, no injection.
const BUILTIN_IDS = ["default", "short", "long", "research", "review", "cautious"];

// --- built-ins are always present, with localized default instructions ------
for (const raw of [undefined, null, "garbage", 42, {}]) {
  for (const language of ["zh", "en"]) {
    const modes = tm.normalizeTaskModes(raw, language);
    assert.deepEqual(modes.map((m) => m.id), BUILTIN_IDS, `re-seed for ${String(raw)} (${language})`);
    const def = modes.find((m) => m.id === "default");
    assert.ok(def.builtin);
    assert.equal(def.permission, undefined); // baseline: changes nothing
    assert.equal(def.thinking, undefined);
    assert.equal(def.instructions, undefined);
    const short = modes.find((m) => m.id === "short");
    assert.equal(short.permission, "sandbox");
    assert.equal(short.thinking, "low");
    assert.equal(short.instructions, undefined); // quick mode stays lean: no injection
    for (const id of ["long", "research", "review", "cautious"]) {
      const m = modes.find((x) => x.id === id);
      assert.ok(m.builtin);
      assert.ok(typeof m.instructions === "string" && m.instructions.length > 10, `${id} has ${language} instructions`);
    }
    // localized: zh text contains CJK, en does not
    const long = modes.find((m) => m.id === "long");
    if (language === "zh") assert.ok(/[\u4e00-\u9fff]/.test(long.instructions));
    else assert.ok(!/[\u4e00-\u9fff]/.test(long.instructions));
  }
}

// --- custom modes survive; invalid fields are dropped ------------------------
{
  const modes = tm.normalizeTaskModes(
    [
      { id: "x", name: "代码评审", permission: "readonly", thinking: "high" },
      { id: "y", name: "Y", permission: "hacked", thinking: "ultra" }, // invalid values dropped
      { name: "no id" }, // unusable entry
    ],
    "zh",
  );
  const x = modes.find((m) => m.id === "x");
  assert.deepEqual(x, { id: "x", name: "代码评审", permission: "readonly", thinking: "high" });
  const y = modes.find((m) => m.id === "y");
  assert.equal(y.permission, undefined);
  assert.equal(y.thinking, undefined);
  assert.ok(!modes.some((m) => !m.id));
}

// --- behavioural fields are sanitized ----------------------------------------
{
  const longInstructions = "i".repeat(5000);
  const modes = tm.normalizeTaskModes(
    [
      { id: "a", name: "A", instructions: ` ${longInstructions} `, specFile: "relative/path.md" }, // relative dropped
      { id: "b", name: "B", instructions: "", specFile: "C:\\docs\\spec.md" }, // empty instr, win path kept
      { id: "c", name: "C", specFile: "/home/u/spec.md" }, // posix absolute kept
    ],
    "en",
  );
  const a = modes.find((m) => m.id === "a");
  assert.equal(a.instructions, longInstructions.slice(0, 4000)); // capped + trimmed
  assert.equal(a.specFile, undefined);
  const b = modes.find((m) => m.id === "b");
  assert.equal(b.instructions, undefined);
  assert.equal(b.specFile, "C:\\docs\\spec.md");
  const c = modes.find((m) => m.id === "c");
  assert.equal(c.specFile, "/home/u/spec.md");
}

// --- duplicate ids: first wins; builtin flag only honored for known ids ------
{
  const modes = tm.normalizeTaskModes(
    [
      { id: "dup", name: "first" },
      { id: "dup", name: "second" },
      { id: "evil", name: "fake builtin", builtin: true },
      { id: "research", permission: "full" }, // user edit to a known builtin id
    ],
    "zh",
  );
  assert.equal(modes.filter((m) => m.id === "dup").length, 1);
  assert.equal(modes.find((m) => m.id === "dup").name, "first");
  assert.ok(!modes.find((m) => m.id === "evil").builtin); // deletable
  const research = modes.find((m) => m.id === "research");
  assert.equal(research.permission, "full"); // user edit kept
  assert.ok(research.builtin); // still a builtin (delete-blocked)
}

// --- user edits to built-ins persist; missing builtin re-seeded --------------
{
  const modes = tm.normalizeTaskModes([{ id: "long", permission: "full" }], "en");
  const long = modes.find((m) => m.id === "long");
  assert.equal(long.permission, "full"); // user edit kept
  assert.equal(long.thinking, undefined); // not re-defaulted wholesale
  const short = modes.find((m) => m.id === "short");
  assert.deepEqual(short, { id: "short", builtin: true, permission: "sandbox", thinking: "low" });
}

// --- legacy configs saved before “default” existed: it still leads ----------
{
  const legacy = [
    { id: "short", builtin: true, permission: "sandbox", thinking: "low" },
    { id: "long", builtin: true, permission: "sandbox", thinking: "high" },
    { id: "research", builtin: true },
    { id: "review", builtin: true },
    { id: "cautious", builtin: true },
  ];
  const modes = tm.normalizeTaskModes(legacy, "zh");
  assert.equal(modes[0].id, "default", "default leads even for legacy saved order");
}

// --- safety cap ---------------------------------------------------------------
{
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }));
  assert.equal(tm.normalizeTaskModes(many, "zh").length, tm.MAX_MODES);
}

// --- display helpers ----------------------------------------------------------
{
  const short = { id: "short", builtin: true };
  const custom = { id: "c1", name: "Code review" };
  assert.equal(tm.taskModeName(short, "zh"), "短任务");
  assert.equal(tm.taskModeName(short, "en"), "Short task");
  assert.equal(tm.taskModeName({ id: "default" }, "zh"), "默认");
  assert.equal(tm.taskModeName({ id: "default" }, "en"), "Default");
  assert.equal(tm.taskModeName({ id: "research" }, "zh"), "调研");
  assert.equal(tm.taskModeName({ id: "review" }, "en"), "Review");
  assert.equal(tm.taskModeName(custom, "zh"), "Code review"); // custom name as-is
  assert.equal(tm.taskModeName({ id: "c2" }, "zh"), "未命名模式");

  const seeded = tm.normalizeTaskModes(undefined, "zh");
  // seeded[0] is the baseline default mode — its summary says so explicitly
  assert.equal(tm.taskModeSummary(seeded[0], "zh"), "基线行为（无附加指令）");
  assert.equal(tm.taskModeSummary(seeded.find((m) => m.id === "short"), "zh"), "沙盒 · 低思考");
  assert.equal(tm.taskModeSummary(seeded.find((m) => m.id === "long"), "en"), "Sandbox · High thinking");
  // any param-less mode (custom included) gets the baseline summary
  assert.equal(tm.taskModeSummary({ id: "c3", name: "X" }, "zh"), "基线行为（无附加指令）");
  // spec doc is surfaced in the summary; inline instructions alone are not
  assert.ok(tm.taskModeSummary({ id: "c4", name: "Y", specFile: "/a/b.md" }, "zh").includes("含说明书"));
  assert.equal(
    tm.taskModeSummary({ id: "c5", name: "Z", permission: "full", instructions: "do x" }, "en"),
    "Full access",
  );
}

// --- the real extension source against a stubbed ExtensionAPI -----------------
{
  const extMod = await import("../src/main/mpi-taskmode-ext.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "mpi-taskmode-state-"));
  try {
    process.env.MPI_TASKMODE_DIR = stateDir;
    const handlers = {};
    extMod.default({ on: (name, handler) => (handlers[name] = handler) });
    assert.deepEqual(Object.keys(handlers), ["before_agent_start"]);

    const ctxFor = (sessionFile) => ({ sessionManager: { getSessionFile: () => sessionFile } });
    const run = async (state, sessionFile = "proj_aaa.jsonl") => {
      if (state === null) rmSync(join(stateDir, "aaa.json"), { force: true });
      else writeFileSync(join(stateDir, "aaa.json"), JSON.stringify(state));
      return handlers.before_agent_start({ systemPrompt: "BASE PROMPT" }, ctxFor(sessionFile));
    };

    // no state file → nothing injected (undefined result)
    assert.equal(await run(null), undefined);
    // unknown session uuid → nothing injected
    writeFileSync(join(stateDir, "aaa.json"), JSON.stringify({ instructions: "DO X" }));
    assert.equal(
      await handlers.before_agent_start({ systemPrompt: "BASE PROMPT" }, ctxFor("proj_bbb.jsonl")),
      undefined,
    );
    // empty state → nothing injected
    assert.equal(await run({}), undefined);

    // instructions only
    let r = await run({ instructions: "  DO X  " });
    assert.ok(r.systemPrompt.startsWith("BASE PROMPT\n\n"), r.systemPrompt.slice(0, 40));
    assert.ok(r.systemPrompt.includes("DO X"));
    assert.ok(!r.systemPrompt.includes("说明书"));

    // spec document content is appended (and a missing spec file is skipped)
    const specFile = join(stateDir, "spec.md");
    writeFileSync(specFile, "# 设计说明书\n- 规则一\n- 规则二");
    r = await run({ instructions: "DO X", specFile });
    assert.ok(r.systemPrompt.includes("DO X") && r.systemPrompt.includes("# 设计说明书") && r.systemPrompt.includes("- 规则二"));
    r = await run({ specFile: join(stateDir, "missing.md") });
    assert.equal(r, undefined); // nothing usable → no injection at all

    // corrupt state file behaves as absent (never breaks the turn)
    writeFileSync(join(stateDir, "aaa.json"), "{not json");
    assert.equal(
      await handlers.before_agent_start({ systemPrompt: "BASE PROMPT" }, ctxFor("proj_aaa.jsonl")),
      undefined,
    );

    // session files without a uuid suffix are ignored
    writeFileSync(join(stateDir, "aaa.json"), JSON.stringify({ instructions: "DO X" }));
    assert.equal(
      await handlers.before_agent_start({ systemPrompt: "BASE PROMPT" }, ctxFor("plain-session.jsonl")),
      undefined,
    );
  } finally {
    delete process.env.MPI_TASKMODE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  }
}

console.log("task-modes tests passed");
