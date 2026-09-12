import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const tm = await import("../src/renderer/src/lib/task-modes.ts");

// Consolidated built-in list: balanced (everyday default) + iterate (loop-dev)
// + the enforced read-only research/review pair.
const BUILTIN_IDS = ["balanced", "iterate", "research", "review"];
const ITERATE_SPEC = "@agent/skills/loop-dev/SKILL.md";

// --- built-ins are always present, with localized default instructions ------.
for (const raw of [undefined, null, "garbage", 42, {}]) {
  for (const language of ["zh", "en"]) {
    const modes = tm.normalizeTaskModes(raw, language);
    assert.deepEqual(modes.map((m) => m.id), BUILTIN_IDS, `re-seed for ${String(raw)} (${language})`);

    const balanced = modes.find((m) => m.id === "balanced");
    assert.ok(balanced.builtin);
    assert.equal(balanced.permission, "sandbox");
    assert.equal(balanced.thinking, "low");
    assert.equal(balanced.instructions, undefined); // everyday mode stays lean: no injection
    assert.equal(balanced.specFile, undefined);

    const iterate = modes.find((m) => m.id === "iterate");
    assert.equal(iterate.permission, "full");
    assert.equal(iterate.thinking, "low");
    assert.equal(iterate.specFile, ITERATE_SPEC); // portable @agent token, not an absolute path

    for (const id of ["iterate", "research", "review"]) {
      const m = modes.find((x) => x.id === id);
      assert.ok(m.builtin);
      assert.ok(typeof m.instructions === "string" && m.instructions.length > 10, `${id} has ${language} instructions`);
    }
    // localized: zh text contains CJK, en does not
    const localized = modes.find((m) => m.id === "research");
    if (language === "zh") assert.ok(/[\u4e00-\u9fff]/.test(localized.instructions));
    else assert.ok(!/[\u4e00-\u9fff]/.test(localized.instructions));
  }
}

// --- built-in instructions stay environment-agnostic (no hardcoded tools) ----.
{
  for (const language of ["zh", "en"]) {
    const modes = tm.normalizeTaskModes(undefined, language);
    for (const m of modes) {
      if (typeof m.instructions === "string") {
        assert.ok(!/mem0/i.test(m.instructions), `${m.id} (${language}) must not hardcode a specific memory tool`);
      }
    }
    // The iterate retrospective must defer to whatever memory/knowledge tool exists.
    const iterate = modes.find((m) => m.id === "iterate").instructions;
    if (language === "zh") assert.ok(/记忆\/知识库/.test(iterate), "zh iterate text should defer to any memory/knowledge tool");
    else assert.ok(/memory\/knowledge/i.test(iterate), "en iterate text should defer to any memory/knowledge tool");
  }
}

// --- custom modes survive; invalid fields are dropped ------------------------.
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

// --- behavioural fields are sanitized ----------------------------------------.
{
  const longInstructions = "i".repeat(5000);
  const modes = tm.normalizeTaskModes(
    [
      { id: "a", name: "A", instructions: ` ${longInstructions} `, specFile: "relative/path.md" }, // relative dropped
      { id: "b", name: "B", instructions: "", specFile: "C:\\docs\\spec.md" }, // empty instr, win path kept
      { id: "c", name: "C", specFile: "/home/u/spec.md" }, // posix absolute kept
      { id: "d", name: "D", specFile: "@agent/skills/loop-dev/SKILL.md" }, // portable token kept
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
  const d = modes.find((m) => m.id === "d");
  assert.equal(d.specFile, "@agent/skills/loop-dev/SKILL.md");
}

// --- duplicate ids: first wins; builtin flag only honored for known ids ------.
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
  assert.equal(research.permission, "readonly"); // pinned: the floor makes a custom permission a dead param
  assert.equal(research.enforce, "readonly");
  assert.ok(research.builtin); // still a builtin (delete-blocked)
}

// --- user edits to built-ins persist; missing builtin re-seeded --------------.
{
  const modes = tm.normalizeTaskModes([{ id: "iterate", permission: "sandbox" }], "en");
  const iterate = modes.find((m) => m.id === "iterate");
  assert.equal(iterate.permission, "sandbox"); // user edit kept
  assert.equal(iterate.thinking, undefined); // not re-defaulted wholesale
  const balanced = modes.find((m) => m.id === "balanced");
  assert.deepEqual(balanced, { id: "balanced", builtin: true, permission: "sandbox", thinking: "low" });
}

// --- retired shipped defaults are refreshed; genuine user edits kept --------.
{
  const oldIterate =
    "当前处于迭代模式：按 loop-dev 闭环流程执行长任务——先侦察并把大任务拆成小任务（每步 ≤15 分钟），生成计划与文本 DAG 展示给用户并等待批准；批准后逐步执行，每步以可复现的检查点验收，发现偏差时只修正受影响的下游步骤并说明；全部完成后先集成再验证，把结论写回 mem0 并向用户汇报与复盘。完整规范见「模式说明书」（loop-dev skill）。";
  const fresh = tm.normalizeTaskModes(undefined, "zh").find((m) => m.id === "iterate").instructions;
  const refreshed = tm.normalizeTaskModes([{ id: "iterate", builtin: true, instructions: oldIterate }], "zh");
  const it = refreshed.find((m) => m.id === "iterate");
  assert.ok(!/mem0/i.test(it.instructions), "exact retired default must be refreshed to the generic text");
  assert.equal(it.instructions, fresh, "refreshed text equals the current shipped default");

  // Anything not matching a retired text is treated as a user edit and kept.
  const edited = tm.normalizeTaskModes([{ id: "iterate", builtin: true, instructions: "记住：永远先跑测试" }], "zh");
  assert.equal(edited.find((m) => m.id === "iterate").instructions, "记住：永远先跑测试");

  // Research/review defaults were revised too (the redundant read-only prefix
  // is owned by the code-level contract). A stale stored copy must migrate,
  // and the shipped defaults must not re-introduce the duplication.
  const oldResearch =
    "当前处于调研模式（本模式强制只读，任何写操作都会被系统拦截）：先广泛收集信息（网络搜索、读文件、查文档），关键事实尽量多源交叉验证；完成后必须先输出完整调研方案——结论（标注来源并区分「已核实」与「推测」）+ 建议执行步骤——然后停下来等待用户确认；在用户明确批准之前，不要尝试任何部署、安装或写操作。信息不足时如实说明，不要编造。";
  const migrated = tm
    .normalizeTaskModes([{ id: "research", builtin: true, instructions: oldResearch }], "zh")
    .find((m) => m.id === "research");
  assert.ok(!migrated.instructions.includes("本模式强制只读"), "stale research default must be refreshed");
  assert.ok(migrated.instructions.includes("已核实 / 推测 / 未知"), "new research output contract present after refresh");
  for (const id of ["research", "review"]) {
    const m = tm.normalizeTaskModes(undefined, "zh").find((x) => x.id === id);
    assert.ok(
      !m.instructions.includes("本模式强制只读"),
      `${id} default must not duplicate the code-level read-only contract`,
    );
  }
}

// --- legacy configs: removed built-ins are cleaned, balanced leads ----------.
{
  const legacy = [
    { id: "default", builtin: true },
    { id: "short", builtin: true, permission: "sandbox", thinking: "low" },
    { id: "cautious", builtin: true, permission: "strict", thinking: "medium" },
    { id: "long", builtin: true },
    { id: "research", builtin: true },
    { id: "review", builtin: true },
  ];
  const modes = tm.normalizeTaskModes(legacy, "zh");
  for (const gone of ["default", "short", "cautious", "long"]) {
    assert.ok(!modes.some((m) => m.id === gone), `${gone} must be removed, not degraded to a custom mode`);
  }
  assert.equal(modes[0].id, "balanced", "balanced leads even for legacy saved order");
  assert.deepEqual(modes.map((m) => m.id), BUILTIN_IDS);
}

// --- safety cap ---------------------------------------------------------------.
{
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }));
  assert.equal(tm.normalizeTaskModes(many, "zh").length, tm.MAX_MODES);
}

// --- enforce floor: seeded on research/review, forced even for legacy configs -.
{
  const modes = tm.normalizeTaskModes(undefined, "zh");
  assert.equal(modes.find((m) => m.id === "research").enforce, "readonly");
  assert.equal(modes.find((m) => m.id === "review").enforce, "readonly");
  for (const id of ["balanced", "iterate"]) {
    assert.equal(modes.find((m) => m.id === id).enforce, undefined, `${id} must not be enforced`);
  }

  // Configs saved before enforce existed keep their user edits but the floor is
  // forced back on — otherwise research+full would stay a hole after upgrade.
  // The dead `permission` is pinned to read-only so the summary/config agree.
  const legacy = tm.normalizeTaskModes(
    [{ id: "research", builtin: true, permission: "full" }, { id: "review", builtin: true }],
    "zh",
  );
  assert.equal(legacy.find((m) => m.id === "research").enforce, "readonly");
  assert.equal(legacy.find((m) => m.id === "research").permission, "readonly");
  assert.equal(legacy.find((m) => m.id === "review").enforce, "readonly");
  assert.equal(legacy.find((m) => m.id === "review").permission, "readonly");

  // Custom modes keep whatever they declare; invalid values are dropped.
  const custom = tm.normalizeTaskModes(
    [
      { id: "c1", name: "X", enforce: "readonly" },
      { id: "c2", name: "Y", enforce: "hacked" },
    ],
    "en",
  );
  assert.equal(custom.find((m) => m.id === "c1").enforce, "readonly");
  assert.equal(custom.find((m) => m.id === "c2").enforce, undefined);

  // The floor is surfaced in the dropdown summary, and the overridden
  // permission is hidden so it never reads as “read-only · enforced read-only”.
  const seeded = tm.normalizeTaskModes(undefined, "zh");
  assert.equal(tm.taskModeSummary(seeded.find((m) => m.id === "research"), "zh"), "中思考 · 强制只读");
  assert.ok(tm.taskModeSummary(seeded.find((m) => m.id === "review"), "en").includes("enforced read-only"));
  assert.ok(!tm.taskModeSummary(seeded.find((m) => m.id === "review"), "en").includes("Read-only ·"));
}

// --- default-mode resolution --------------------------------------------------.
{
  const modes = tm.normalizeTaskModes(undefined, "zh");
  assert.equal(tm.resolveDefaultTaskMode(modes, undefined).id, "balanced");
  assert.equal(tm.resolveDefaultTaskMode(modes, "iterate").id, "iterate");
  assert.equal(tm.resolveDefaultTaskMode(modes, "short").id, "balanced"); // removed id falls back
  assert.equal(tm.resolveDefaultTaskMode([], "x"), undefined);
}

// --- display helpers ----------------------------------------------------------.
{
  const custom = { id: "c1", name: "Code review" };
  assert.equal(tm.taskModeName({ id: "balanced" }, "zh"), "均衡");
  assert.equal(tm.taskModeName({ id: "balanced" }, "en"), "Balanced");
  assert.equal(tm.taskModeName({ id: "iterate" }, "zh"), "迭代");
  assert.equal(tm.taskModeName({ id: "iterate" }, "en"), "Iterate");
  assert.equal(tm.taskModeName({ id: "research" }, "zh"), "调研");
  assert.equal(tm.taskModeName({ id: "review" }, "en"), "Review");
  assert.equal(tm.taskModeName(custom, "zh"), "Code review"); // custom name as-is
  assert.equal(tm.taskModeName({ id: "c2" }, "zh"), "未命名模式");

  const seeded = tm.normalizeTaskModes(undefined, "zh");
  assert.equal(tm.taskModeSummary(seeded.find((m) => m.id === "balanced"), "zh"), "沙盒 · 低思考");
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
    assert.deepEqual(Object.keys(handlers).sort(), ["before_agent_start", "tool_call"]);

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

    // enforce=readonly hides write/edit via setActiveTools; clearing restores.
    const activeTools = ["read", "bash", "write", "edit"];
    const piStub2 = {
      on(name, handler) {
        handlers[name] = handler;
      },
      getActiveTools: () => [...activeTools],
      setActiveTools(names) {
        activeTools.length = 0;
        activeTools.push(...names);
      },
    };
    extMod.default(piStub2);
    r = await run({ instructions: "DO X", enforce: "readonly" });
    assert.ok(r.systemPrompt.includes("DO X"), "instructions still injected alongside enforce");
    assert.deepEqual(activeTools, ["read", "bash"], "write/edit hidden while enforced read-only");

    // Enforced read-only contract (2026-09 review-mode fix): a system-fixed
    // conflict-reporting block is injected for enforce=readonly — even WITHOUT
    // any user instructions — and placed BEFORE the editable instruction text
    // so "report incompatible requests in the first reply" outranks workflow.
    r = await run({ enforce: "readonly" });
    assert.ok(r.systemPrompt.includes("强制只读契约"), "contract injected with enforce only (zh)");
    assert.ok(r.systemPrompt.includes("Enforced read-only contract"), "contract injected with enforce only (en)");
    assert.ok(r.systemPrompt.includes("第一条回复"), "conflict-reporting rule present (zh)");
    assert.ok(/FIRST reply MUST/.test(r.systemPrompt), "conflict-reporting rule present (en)");
    r = await run({ instructions: "DO X", enforce: "readonly" });
    const contractIdx = r.systemPrompt.indexOf("强制只读契约");
    const instrIdx = r.systemPrompt.indexOf("DO X");
    assert.ok(
      contractIdx !== -1 && instrIdx !== -1 && contractIdx < instrIdx,
      "contract must precede user-editable instructions",
    );
    await run({ instructions: "DO X", enforce: "readonly" }); // idempotent on next turn
    assert.deepEqual(activeTools, ["read", "bash"]);
    r = await run(null); // mode cleared → tools come back
    assert.equal(r, undefined);
    assert.deepEqual([...activeTools].sort(), ["bash", "edit", "read", "write"], "tools restored after clear");

    // Mid-turn reconciliation via the tool_call hook (F1): an approved
    // mpi_request_mode_switch deletes the state file while the turn is still
    // running — write/edit must come back on the next tool call WITHOUT waiting
    // for before_agent_start. Reverse direction: a mode applied mid-turn hides
    // the tools immediately.
    r = await run({ instructions: "DO X", enforce: "readonly" }); // re-apply (new turn)
    assert.deepEqual(activeTools, ["read", "bash"], "hidden again after re-apply");
    rmSync(join(stateDir, "aaa.json"), { force: true }); // main deleted state on approval
    await handlers.tool_call({}, ctxFor("proj_aaa.jsonl"));
    assert.deepEqual(
      [...activeTools].sort(),
      ["bash", "edit", "read", "write"],
      "restored mid-turn via tool_call",
    );

    writeFileSync(join(stateDir, "aaa.json"), JSON.stringify({ instructions: "DO X", enforce: "readonly" }));
    await handlers.tool_call({}, ctxFor("proj_aaa.jsonl"));
    assert.deepEqual(activeTools, ["read", "bash"], "hidden mid-turn via tool_call");

    // The hook never blocks and is a no-op without env/session context.
    assert.equal(await handlers.tool_call({}, {}), undefined);
  } finally {
    delete process.env.MPI_TASKMODE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  }
}

console.log("task-modes tests passed");
