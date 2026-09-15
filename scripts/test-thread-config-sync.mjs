/**
 * 会话配置同步（S3 纯函数核心）测试 —— src/main/thread-config.ts
 *
 *   1. buildConfigPatch：丢 undefined、保留显式 null、空补丁返回 null
 *   2. resolveModeById：用户配置 / 内置目录回退 / 未知 id
 *   3. planModeApplication：enforce=readonly 把权限钉死；状态文件内容与清除
 *   4. 内置模式目录可用性（balanced/iterate 即使从未落盘也能解析）
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { buildConfigPatch, resolveModeById, planModeApplication, planModeClear } = await import(
  "../src/main/thread-config.ts"
);

// ---- 1. buildConfigPatch ----------------------------------------------------
{
  assert.equal(buildConfigPatch({}), null, "空输入 → null（调用方跳过广播）");
  assert.equal(buildConfigPatch({ permission: undefined }), null, "全 undefined → null");

  assert.deepEqual(buildConfigPatch({ permission: "sandbox" }), { permission: "sandbox" });

  // taskMode 的 null 是「清除模式」这一有效值，不能被当成 undefined 丢掉
  assert.deepEqual(buildConfigPatch({ taskMode: null }), { taskMode: null });
  assert.deepEqual(buildConfigPatch({ model: null }), { model: null });

  const multi = buildConfigPatch({ permission: "full", thinkingLevel: "high", taskMode: "iterate" });
  assert.deepEqual(multi, { permission: "full", thinkingLevel: "high", taskMode: "iterate" });

  console.log("ok 1 - buildConfigPatch: undefined 丢弃、null 保留、空补丁为 null");
}

// ---- 2. resolveModeById -----------------------------------------------------
{
  // 用户配置里的自定义模式
  const custom = [{ id: "my-mode", name: "我的模式", permission: "strict", thinking: "medium" }];
  const mine = resolveModeById(custom, "my-mode");
  assert.equal(mine?.id, "my-mode");
  assert.equal(mine?.permission, "strict");

  // 内置的 balanced 从未写进 config（实测 config.taskModes 里只有历史遗留 id），
  // 仍必须能解析出来 —— 这是手机端「均衡」模式可用性的前提
  const balanced = resolveModeById(custom, "balanced");
  assert.equal(balanced?.id, "balanced", "内置 balanced 即使未落盘也要能解析");
  assert.equal(balanced?.permission, "sandbox", "内置 balanced = 沙盒 + 低思考");
  assert.equal(balanced?.thinking, "low");

  const iterate = resolveModeById([], "iterate");
  assert.equal(iterate?.id, "iterate");
  assert.ok(iterate?.specFile?.startsWith("@agent/"), "iterate 带便携 @agent/ 说明书路径");

  // 历史遗留 id（short/long/cautious）已被归一化清理，不得复活
  assert.equal(resolveModeById([{ id: "long", permission: "full" }], "long"), null, "已废弃 id 不解析");

  assert.equal(resolveModeById([], "nope"), null, "未知 id → null");
  assert.equal(resolveModeById([], "  "), null, "空 id → null");

  console.log("ok 2 - resolveModeById: 用户配置 → 内置目录回退 → 废弃/未知 id 拒绝");
}

// ---- 3. planModeApplication -------------------------------------------------
{
  // 研究模式：enforce=readonly 把权限钉死成 readonly，即使定义里写了 sandbox
  const research = planModeApplication({
    id: "research",
    permission: "sandbox",
    thinking: "medium",
    enforce: "readonly",
    instructions: "  调研……  ",
  });
  assert.equal(research.permission, "readonly", "enforce=readonly 覆盖 permission");
  assert.equal(research.thinking, "medium");
  assert.deepEqual(research.state, { instructions: "调研……", specFile: "", enforce: "readonly" });

  // 普通模式：没有行为内容 → state=null（表示删除状态文件）
  const bare = planModeApplication({ id: "balanced", permission: "sandbox", thinking: "low" });
  assert.equal(bare.permission, "sandbox");
  assert.equal(bare.state, null, "无指令/说明书/强制 → state=null（清除注入）");

  // 只有说明书也算有状态
  const spec = planModeApplication({ id: "iterate", specFile: "@agent/skills/loop-dev/SKILL.md" });
  assert.equal(spec.state?.specFile, "@agent/skills/loop-dev/SKILL.md");
  assert.equal(spec.state?.enforce, null);
  assert.equal(spec.permission, undefined, "模式未指定权限 → 不改变当前权限");

  // 清除模式：只删状态，权限/思考不动
  assert.deepEqual(planModeClear(), { modeId: "", state: null });

  console.log("ok 3 - planModeApplication: 强制只读钉死权限 + 状态文件语义");
}

// ---- 4. 目录与归一化一致性 --------------------------------------------------
{
  // 归一化后的列表必须包含四个内置项且顺序固定（桌面下拉与手机抽屉同序）
  const { normalizeTaskModes } = await import("../src/shared/task-mode-catalog.ts");
  const modes = normalizeTaskModes([{ id: "long", permission: "full" }], "zh");
  assert.deepEqual(
    modes.map((m) => m.id),
    ["balanced", "iterate", "research", "review"],
    "内置模式固定顺序 + 废弃 id 清理",
  );
  assert.ok(modes.every((m) => m.permission), "每个内置模式都带权限参数（手机端可直接展示）");

  console.log("ok 4 - 模式目录：归一化顺序固定、内置参数齐全");
}

console.log("thread-config sync tests passed");
