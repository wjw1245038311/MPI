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

// ---- 5. 上下文用量 + 压缩（手机端可见性与回退口径） -----------------------
{
  const { RemoteService } = await import("../src/main/remote/service.ts");
  const { REMOTE_REQUEST_TYPES } = await import("../mobile/shared/protocol.ts");

  assert.ok(REMOTE_REQUEST_TYPES.includes("thread.compact"), "协议必须声明 thread.compact");
  assert.equal(REMOTE_REQUEST_TYPES.indexOf("thread.compact"), REMOTE_REQUEST_TYPES.indexOf("thread.setMode") + 1, "两份协议的顺序必须一致（pwa-shared 会 deepEqual）");

  // 用量口径直接用**真实模块**（不与实现各写一份，否则测的是副本）。
  const { readContextUsage, contextBand, formatTokens } = await import("../mobile/pwa/src/lib/context-usage.ts");
  const pctOf = (usage) => readContextUsage(usage).percent;
  assert.equal(pctOf({ tokens: 62_000, contextWindow: 100_000, percent: 62 }), 62, "pi 给了 percent 就用它");
  assert.equal(pctOf({ tokens: 62_000, contextWindow: 100_000, percent: null }), 62, "缺 percent 时用 tokens/window 自算");
  // 压缩后 pi 把 tokens 报成 null —— 必须回退估算值，而不是显示 0%
  const afterCompaction = readContextUsage({ tokens: null, contextWindow: 100_000, percent: null, estimatedTokens: 12_000 });
  assert.equal(afterCompaction.percent, 12, "压缩后用 estimatedTokens 回退");
  assert.equal(afterCompaction.isEstimate, true, "要标记这是估算值（界面加提示）");
  assert.equal(readContextUsage({ tokens: null, contextWindow: 0, percent: null }).hasValue, false, "窗口未知时显示「—」而不是 0%");
  assert.equal(readContextUsage(null).hasValue, false, "没有用量数据时显示「—」");

  assert.deepEqual([55, 60, 74, 75, 89, 90, 95].map(contextBand), ["low", "warn", "warn", "mid", "mid", "hi", "hi"], "阈值带与桌面端一致");
  assert.deepEqual([880, 4200, 62_000, 132_400].map(formatTokens), ["880", "4.2k", "62k", "132k"], "数字缩写");

  // 历史下发上限：原来写死 80 条（用户「往上拉不动」的根因）。
  const { MAX_REMOTE_HISTORY, trimRemoteHistory, REMOTE_HISTORY_BYTE_BUDGET } = await import("../src/main/remote/history-limit.ts");
  assert.ok(MAX_REMOTE_HISTORY >= 300, "历史条数上限必须够大（曾为 80）");
  const many = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, role: "assistant", text: `msg ${i}` }));
  assert.equal(many.slice(-MAX_REMOTE_HISTORY)[0].id, "m100", "超过上限时保留最新的 N 条");
  // 条数上限在映射前用 slice(-MAX_REMOTE_HISTORY) 施加，trimRemoteHistory 只管字节预算。
  assert.equal(trimRemoteHistory(many).length, 500, "未超字节预算时不做额外裁剪");
  // 字节预算：单条巨大消息要把最旧的挤出去，但最后一条永远保留。
  const huge = Array.from({ length: 20 }, (_, i) => ({ id: `h${i}`, role: "assistant", text: "x".repeat(1_000_000) }));
  const trimmed = trimRemoteHistory(huge);
  assert.ok(trimmed.length < huge.length, "超预算时从最旧开始丢");
  assert.equal(trimmed.at(-1).id, "h19", "最后一条（最新消息）必须保留");
  assert.ok(trimmed.length >= 1);
  assert.deepEqual(trimRemoteHistory([]), [], "空历史安全");
  assert.equal(trimRemoteHistory([{ id: "only", role: "assistant", text: "x".repeat(REMOTE_HISTORY_BYTE_BUDGET * 2) }]).length, 1, "单条超预算也要保留");

  // 压缩是写操作：必须被写租约拦住（另一个设备在编辑时不能压）。
  // 注意 RemoteService.handle 不抛异常——失败会变成 error 信封，经 context.send 发出。
  const calls = [];
  const sent = [];
  const backend = {
    compact: async (threadId) => { calls.push(threadId); return { ok: true }; },
    getThread: async () => ({}),
  };
  const service = new RemoteService(backend, { now: () => Date.now() });
  let seq = 0;
  const ctx = { connectionId: "c1", deviceId: "d1", send: (message) => sent.push(message) };
  const req = (type, payload = {}) => ({ id: `${type}-${++seq}`, type, sessionId: "s1", threadId: "t1", payload });
  const lastError = () => sent.at(-1)?.error?.code;

  await service.handle(req("thread.compact"), ctx);
  assert.equal(lastError(), "WRITE_CLAIM_REQUIRED", "没有写租约时必须拒绝压缩");
  assert.equal(calls.length, 0, "被拒时不应打到 backend");

  await service.handle(req("thread.claimWrite"), ctx);
  await service.handle(req("thread.compact"), ctx);
  assert.deepEqual(calls, ["t1"], "拿到租约后转发到 backend.compact");
  assert.equal(sent.at(-1)?.error, undefined, "有租约时不应报错");

  // 另一个连接已持租约 → 压缩必须是 THREAD_BUSY（不能抢别人的会话）。
  const other = { connectionId: "c2", deviceId: "d2", send: (m) => sent.push(m) };
  await service.handle({ ...req("thread.compact"), connectionId: "c2" }, other);
  assert.equal(lastError(), "THREAD_BUSY", "别的设备持有租约时压缩应返回 THREAD_BUSY");
  assert.deepEqual(calls, ["t1"], "THREAD_BUSY 时不应再推进 backend");

  console.log("ok 5 - context usage: compact 请求/写租约/百分比回退/阈值带");
}
