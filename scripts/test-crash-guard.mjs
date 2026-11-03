/**
 * 崩溃有界恢复（L1）：`src/main/crash-guard.ts` 的纯判定逻辑。
 *
 * 这里锁三条不能退化的行为：
 *   ① 窗口外的崩溃不累计（一天崩两次 ≠ 坏驱动）；
 *   ② 第 3 次才升级软件渲染，且**已在软件渲染时不会再 relaunch**（防无限重启循环）；
 *   ③ GPU 崩溃只标记、不 relaunch，且已经在软件渲染时不再重复标记。
 *
 * 落盘与 Electron 接线（index.ts）跑不了 L1，靠实机：故意让渲染进程崩溃后
 * 看 diag 里的 `crash-guard renderer-gone … action=`。
 */
import assert from "node:assert/strict";
import {
  CRASH_WINDOW_MS,
  GPU_CRASH_LIMIT,
  RENDERER_RELOAD_LIMIT,
  crashGuardSummary,
  emptyCrashGuardState,
  markSoftwareRendering,
  pruneEvents,
  recordGpuCrash,
  recordRendererCrash,
  sanitizeCrashGuardState,
} from "../src/main/crash-guard.ts";

const T0 = 1_760_000_000_000;

// --- 窗口裁剪 ------------------------------------------------------------------
{
  const events = [
    { at: T0 - CRASH_WINDOW_MS - 1, reason: "old" },
    { at: T0 - 1000, reason: "recent" },
  ];
  const pruned = pruneEvents(events, T0);
  assert.equal(pruned.length, 1, "窗口外的崩溃必须被丢掉");
  assert.equal(pruned[0].reason, "recent");
  assert.deepEqual(pruneEvents([{ at: T0 + 5000, reason: "slight-skew" }], T0).length, 1, "几秒内的时钟偏差要容忍（不丢弃）");
  assert.deepEqual(pruneEvents([{ at: T0 + 10 * 60 * 1000, reason: "future" }], T0).length, 0, "远超窗口的未来时间戳（时钟回拨）丢掉");
}

// --- 渲染进程：reload → reload → software-render --------------------------------
{
  let state = emptyCrashGuardState();
  const r1 = recordRendererCrash(state, T0, "crashed");
  assert.equal(r1.action, "reload", `第 1 次崩溃应自动 reload（上限 ${RENDERER_RELOAD_LIMIT}）`);
  state = r1.state;
  const r2 = recordRendererCrash(state, T0 + 10_000, "crashed");
  assert.equal(r2.action, "reload", "第 2 次仍在 reload 预算内");
  state = r2.state;
  const r3 = recordRendererCrash(state, T0 + 20_000, "crashed");
  assert.equal(r3.action, "software-render", "第 3 次必须升级到软件渲染，而不是继续 reload");
  assert.equal(r3.crashesInWindow, 3);
  assert.equal(state.softwareRendering, undefined, "判定本身不改状态，标记由 markSoftwareRendering 负责");
}

// --- 已在软件渲染：第 2 次放弃（不再 relaunch） ---------------------------------
{
  let state = markSoftwareRendering(emptyCrashGuardState(), "gpu-process-crashed");
  assert.equal(state.softwareRendering, true);
  const r1 = recordRendererCrash(state, T0, "crashed");
  assert.equal(r1.action, "reload", "软件渲染下第一次仍给一次 reload 机会");
  state = r1.state;
  const r2 = recordRendererCrash(state, T0 + 5_000, "crashed");
  assert.equal(r2.action, "give-up", "软件渲染下再崩就交给用户，绝不再次 relaunch（防无限循环）");
}

// --- 跨窗口：老崩溃不算数 ------------------------------------------------------
{
  let state = emptyCrashGuardState();
  state = recordRendererCrash(state, T0, "crashed").state;
  state = recordRendererCrash(state, T0 + 1_000, "crashed").state;
  // 隔了 10 分钟以上再崩一次：窗口里只剩这一条 → 回到 reload，不该直接软件渲染。
  const later = recordRendererCrash(state, T0 + CRASH_WINDOW_MS + 5_000, "crashed");
  assert.equal(later.crashesInWindow, 1);
  assert.equal(later.action, "reload");
}

// --- GPU 子进程 ---------------------------------------------------------------
{
  let state = emptyCrashGuardState();
  const g1 = recordGpuCrash(state, T0, "crashed");
  assert.equal(g1.shouldFallbackToSoftware, false, `第 1 次 GPU 崩溃先观察（阈值 ${GPU_CRASH_LIMIT}）`);
  state = g1.state;
  const g2 = recordGpuCrash(state, T0 + 2_000, "crashed");
  assert.equal(g2.shouldFallbackToSoftware, true, "窗口内第 2 次 GPU 崩溃 → 下次启动软件渲染");
  // 已经在软件渲染：不再重复要求切换
  const g3 = recordGpuCrash(markSoftwareRendering(g2.state, "gpu-process-crashed"), T0 + 3_000, "crashed");
  assert.equal(g3.shouldFallbackToSoftware, false);
}

// --- 落盘/读取：坏数据不能炸 ------------------------------------------------
{
  const clean = sanitizeCrashGuardState({
    renderer: [{ at: T0, reason: "x" }, { at: "bad", reason: "y" }, null],
    gpu: "not-an-array",
    softwareRendering: "yes",
    softwareRenderingReason: "  gpu  ",
  });
  assert.equal(clean.renderer.length, 1);
  assert.deepEqual(clean.gpu, []);
  assert.equal(clean.softwareRendering, undefined, "非 true 一律当没开");
  assert.equal(clean.softwareRenderingReason, "gpu", "reason 要 trim");

  for (const junk of [null, undefined, 42, "str", []]) {
    const state = sanitizeCrashGuardState(junk);
    assert.deepEqual(state.renderer, []);
    assert.deepEqual(state.gpu, []);
  }
}

// --- 诊断摘要 -----------------------------------------------------------------
{
  const state = { ...emptyCrashGuardState(), softwareRendering: true };
  assert.equal(crashGuardSummary(state, T0), "crash-guard softwareRendering=on renderer=0 gpu=0");
}

console.log("crash-guard: 全部检查通过");
