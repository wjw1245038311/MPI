import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const tm = await import("../src/renderer/src/lib/task-modes.ts");

// --- built-ins are always present, with default params ----------------------
for (const raw of [undefined, null, "garbage", 42, {}]) {
  const modes = tm.normalizeTaskModes(raw);
  assert.deepEqual(modes.map((m) => m.id), ["short", "long"], `re-seed for ${String(raw)}`);
  assert.equal(modes[0].permission, "sandbox");
  assert.equal(modes[0].thinking, "low");
  assert.equal(modes[1].permission, "sandbox");
  assert.equal(modes[1].thinking, "high");
  for (const m of modes) assert.ok(m.builtin);
}

// --- custom modes survive; invalid fields are dropped ------------------------
{
  const modes = tm.normalizeTaskModes([
    { id: "x", name: "代码评审", permission: "readonly", thinking: "high" },
    { id: "y", name: "Y", permission: "hacked", thinking: "ultra" }, // invalid values dropped
    { name: "no id" }, // unusable entry
  ]);
  const x = modes.find((m) => m.id === "x");
  assert.deepEqual(x, { id: "x", name: "代码评审", permission: "readonly", thinking: "high" });
  const y = modes.find((m) => m.id === "y");
  assert.equal(y.permission, undefined);
  assert.equal(y.thinking, undefined);
  assert.ok(!modes.some((m) => !m.id));
}

// --- duplicate ids: first wins; builtin flag only honored for known ids ------
{
  const modes = tm.normalizeTaskModes([
    { id: "dup", name: "first" },
    { id: "dup", name: "second" },
    { id: "evil", name: "fake builtin", builtin: true },
  ]);
  assert.equal(modes.filter((m) => m.id === "dup").length, 1);
  assert.equal(modes.find((m) => m.id === "dup").name, "first");
  assert.ok(!modes.find((m) => m.id === "evil").builtin); // deletable
}

// --- user edits to built-in params persist; missing builtin re-seeded --------
{
  const modes = tm.normalizeTaskModes([{ id: "long", permission: "full" }]);
  const long = modes.find((m) => m.id === "long");
  assert.equal(long.permission, "full"); // user edit kept
  assert.equal(long.thinking, undefined); // not re-defaulted wholesale
  const short = modes.find((m) => m.id === "short");
  assert.deepEqual(short, { id: "short", builtin: true, permission: "sandbox", thinking: "low" });
}

// --- safety cap ---------------------------------------------------------------
{
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }));
  assert.equal(tm.normalizeTaskModes(many).length, tm.MAX_MODES ?? 20);
}

// --- display helpers ----------------------------------------------------------
{
  const short = { id: "short", builtin: true };
  const long = { id: "long", builtin: true };
  const custom = { id: "c1", name: "Code review" };
  assert.equal(tm.taskModeName(short, "zh"), "短任务");
  assert.equal(tm.taskModeName(short, "en"), "Short task");
  assert.equal(tm.taskModeName(long, "zh"), "长任务");
  assert.equal(tm.taskModeName(custom, "zh"), "Code review"); // custom name as-is
  assert.equal(tm.taskModeName({ id: "c2" }, "zh"), "未命名模式");

  const seeded = tm.normalizeTaskModes(undefined);
  assert.equal(tm.taskModeSummary(seeded[0], "zh"), "沙盒 · 低思考");
  assert.equal(tm.taskModeSummary(seeded[1], "en"), "Sandbox · High thinking");
  assert.equal(tm.taskModeSummary({ id: "c3", name: "X" }, "zh"), "未设置参数");
}

console.log("task-modes tests passed");
