/**
 * 思考等级（`src/shared/thinking-levels.ts`）——三端同源的规则守卫。
 *
 * 背景（2026-10-15 梳理，全部本机 pi 1.2.0 runtime 实测）：
 *   - `get_available_thinking_levels` 的原始返回**不一致**：LM Studio 那台只有
 *     `minimal…max`（没有 off），strata 那台有 off；桌面曾自己补 off、手机端原样用
 *     主机列表 → 那些模型在手机上根本关不掉思考；
 *   - 切模型时 pi 会按新模型的 `thinkingLevelMap` **夹紧**当前档位且不复位
 *     （high → 切过去变 low → 切回来还是 low），用户本意丢失；
 *   - 未打开的会话曾被硬编码成 `["off"]`，看起来像「该模型不支持思考」。
 *
 * 这里钉死：① 归一化规则本身；② 切模型的复位决策（intent 可用就复位、不可用就接受
 * 夹紧但不清空 intent）；③ 安卓侧的标准档位常量不许与 shared 漂移（等价于 Kotlin 单测）。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

const {
  THINKING_LEVEL_ORDER,
  normalizeThinkingLevels,
  thinkingLevelsFromMap,
  isThinkingLevelAllowed,
  planThinkingAfterModelSwitch,
  thinkingLevelLabel,
} = await import("../src/shared/thinking-levels.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

try {
  // ------------------------------------------------------------------ 归一化
  // 实测形状：pi 对某些模型不返回 off，手机原样用 → 关不掉思考。
  assert.deepEqual(normalizeThinkingLevels(["minimal", "low", "medium", "high"]), ["off", "minimal", "low", "medium", "high"]);
  ok("缺 off 的列表会补上 off（手机端能关思考）");

  assert.deepEqual(
    normalizeThinkingLevels(["max", "off", "low", "minimal", "high", "medium", "xhigh"]),
    [...THINKING_LEVEL_ORDER],
  );
  ok("乱序列表按标准档位顺序排（三端展示顺序一致）");

  assert.deepEqual(normalizeThinkingLevels(["off", "high", "high", " mid ", ""]), ["off", "high", "mid"]);
  ok("去重、trim、丢空串；自定义档位排在标准档位之后");

  assert.deepEqual(normalizeThinkingLevels([]), ["off"]);
  assert.deepEqual(normalizeThinkingLevels(undefined), ["off"]);
  assert.deepEqual(normalizeThinkingLevels({ levels: ["high"] }), ["off"]);
  ok("空/非法输入退化成 [\"off\"]（等价于不支持思考）");

  assert.equal(isThinkingLevelAllowed("off", ["minimal", "high"]), true);
  assert.equal(isThinkingLevelAllowed("xhigh", ["minimal", "high"]), false);
  assert.equal(isThinkingLevelAllowed("high", ["minimal", "high"]), true);
  ok("校验：off 永远允许，其余必须在列表里");

  // ------------------------------------------------------- models.json 推导（桥没开）
  assert.deepEqual(thinkingLevelsFromMap(undefined, undefined), [...THINKING_LEVEL_ORDER]);
  assert.deepEqual(thinkingLevelsFromMap(undefined, false), ["off"]);
  assert.deepEqual(
    thinkingLevelsFromMap({ off: null, minimal: null, low: "low", medium: "mid", high: "high", xhigh: null, max: null }, true),
    ["off", "low", "medium", "high"],
  );
  ok("map 里显式 null = 隐藏该档；reasoning:false 只剩 off；但 off 本身不可被隐藏");

  // ------------------------------------------------------------ 切模型的复位决策
  const levels = normalizeThinkingLevels(["minimal", "low", "medium", "high"]);

  // 实测过的场景：本意 high，pi 夹到 low，而新模型支持 high → 必须复位回去。
  assert.deepEqual(planThinkingAfterModelSwitch({ intent: "high", clamped: "low", levels }), {
    restore: "high",
    effective: "high",
    downgraded: false,
  });
  ok("intent 可用却被夹紧 → 复位到 intent");

  assert.deepEqual(planThinkingAfterModelSwitch({ intent: "low", clamped: "low", levels }), {
    restore: null,
    effective: "low",
    downgraded: false,
  });
  ok("已经是 intent → 不做多余 RPC");

  // 新模型根本没有 high（只有 minimal/low）→ 接受夹紧值，但 intent 不清空（界面提示一次）。
  const narrow = normalizeThinkingLevels(["minimal", "low"]);
  assert.deepEqual(planThinkingAfterModelSwitch({ intent: "high", clamped: "low", levels: narrow }), {
    restore: null,
    effective: "low",
    downgraded: true,
  });
  ok("intent 不被支持 → 接受夹紧结果并标记 downgraded（intent 保留，切回可自动恢复）");

  assert.deepEqual(planThinkingAfterModelSwitch({ intent: null, clamped: "medium", levels }), {
    restore: null,
    effective: "medium",
    downgraded: false,
  });
  ok("从没手动选过档位（无 intent）→ 完全跟随 pi");

  assert.deepEqual(planThinkingAfterModelSwitch({ intent: "high", clamped: "low", levels: [] }), {
    restore: null,
    effective: "low",
    downgraded: false,
  });
  ok("可选档位未知（桥没上报）→ 不乱动，避免复位失败反而更糟");

  // --------------------------------------------------------- 安卓侧不许漂移
  const kt = readFileSync(
    join(ROOT, "mobile/app/app/src/main/java/com/mpi/app/ui/ThreadToolbar.kt"),
    "utf8",
  );
  const m = /val STANDARD_THINKING_LEVELS = listOf\(([^)]*)\)/.exec(kt);
  assert.ok(m, "ThreadToolbar.kt 里必须还有 STANDARD_THINKING_LEVELS 常量（改名的话这个守卫要一起改）");
  const kotlinLevels = m[1]
    .split(",")
    .map((raw) => raw.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  assert.deepEqual(kotlinLevels, [...THINKING_LEVEL_ORDER], "安卓标准档位列表与 shared 不一致");
  ok(`安卓 STANDARD_THINKING_LEVELS 与 shared 一致（${kotlinLevels.join("/")}）`);

  // 安卓的中文档位标签也钉住（语言不同没法共享代码，但至少不能漂）。
  const fnStart = kt.indexOf("fun thinkingLevelLabel(");
  const fnBody = fnStart < 0 ? "" : kt.slice(fnStart, kt.indexOf("\n}\n", fnStart));
  const kotlinLabels = {};
  for (const m of fnBody.matchAll(/"([a-z]+)" -> "([^"]+)"/g)) kotlinLabels[m[1]] = m[2];
  const labelDiff = THINKING_LEVEL_ORDER.filter((level) => kotlinLabels[level] !== thinkingLevelLabel(level, "zh")).map(
    (level) => `${level}: 安卓「${kotlinLabels[level]}」 vs 桌面「${thinkingLevelLabel(level, "zh")}」`,
  );
  assert.deepEqual(labelDiff, [], `安卓档位标签与桌面不一致：${labelDiff.join("；")}`);
  ok("安卓档位中文标签与桌面逐字一致（off = 关闭）");

  // ---------------------------------------------------------------- 标签也只有一份
  assert.equal(thinkingLevelLabel("off", "zh"), "关闭");
  assert.equal(thinkingLevelLabel("xhigh", "zh"), "极高");
  assert.equal(thinkingLevelLabel("max", "en"), "max");
  assert.equal(thinkingLevelLabel(undefined, "zh"), "关闭");
  assert.equal(thinkingLevelLabel("mid", "zh"), "mid");
  ok("档位标签单一来源（未知取值原样显示，不隐藏用户自定义映射）");

  // 任务模式摘要里的档位词也走同一函数（以前那里内联了第四份表）。
  const catalog = await import("../src/shared/task-mode-catalog.ts");
  const summaryZh = catalog.taskModeSummary({ id: "m", thinking: "xhigh" }, "zh");
  const summaryEn = catalog.taskModeSummary({ id: "m", thinking: "xhigh" }, "en");
  assert.ok(summaryZh.includes("极高思考"), `zh 摘要应含「极高思考」，实际：${summaryZh}`);
  assert.ok(summaryEn.includes("xhigh thinking"), `en 摘要应含「xhigh thinking」，实际：${summaryEn}`);
  assert.ok(catalog.taskModeSummary({ id: "m", thinking: "off" }, "zh").includes("思考关闭"));
  ok("任务模式摘要的档位词与界面一致（不再内联一份标签表）");

  // -------------------------------------------------- 反漂移：别处不许再抄梯子
  const scanned = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) scanned.push(full);
    }
  };
  for (const rel of [join(ROOT, "src", "main"), join(ROOT, "src", "renderer", "src"), join(ROOT, "src", "shared"), join(ROOT, "src", "preload")]) {
    walk(rel);
  }
  const offenders = [];
  for (const file of scanned) {
    const text = readFileSync(file, "utf8");
    const isCanonical = file.replace(/\\/g, "/").endsWith("src/shared/thinking-levels.ts");
    if (isCanonical) continue;
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
    if (/"off"\s*,\s*"minimal"/.test(text)) offenders.push(`${rel} 又抄了一份档位梯子`);
    if (/xhigh["']?\s*:\s*["']极高/.test(text)) offenders.push(`${rel} 又抄了一份档位标签`);
  }
  assert.deepEqual(offenders, [], offenders.join("；"));
  ok(`档位列表与标签在 src/ 下只有一份（扫了 ${scanned.length} 个文件）`);

  console.log(`\nthinking-levels: ${passed} passed`);
} catch (e) {
  console.error("\n✗ thinking-levels FAILED:", e?.message || e);
  process.exit(1);
}
