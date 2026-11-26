// 门控（automation-gate.ts）单测。
//
// 关键语义：门控不满足 = **跳过**（skipped），不是失败——不告警、不进「待查看」。
// 这条区分是刻意的：把「今天不适用」记成失败会让红点失去信息量。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./electron-stub-loader.mjs", import.meta.url));
const { describeGate, evaluateGate, loadSkipDates, localDateString, parseSkipDate } = await import(
  "../src/main/automation-gate.ts"
);

let checks = 0;
const ok = (label) => {
  checks++;
  return label;
};

const root = mkdtempSync(join(tmpdir(), "mpi-gate-"));
const nodeCmd = process.execPath;

try {
  // ---- parseSkipDate：形状与日历双重校验 ----
  assert.equal(parseSkipDate("2026-12-01"), "2026-12-01", ok("合法日期"));
  assert.equal(parseSkipDate("2026-02-31"), null, ok("2/31 溢出日期被拒（回读校验）"));
  assert.equal(parseSkipDate("2026-13-01"), null, ok("月份越界被拒"));
  assert.equal(parseSkipDate("2026-1-1"), null, ok("必须是两位月日"));
  assert.equal(parseSkipDate("tomorrow"), null, ok("非日期串被拒"));
  assert.equal(parseSkipDate(123), null, ok("非字符串被拒"));
  assert.equal(parseSkipDate("2028-02-29"), "2028-02-29", ok("闰日合法"));

  // ---- localDateString ----
  assert.equal(localDateString(new Date(2026, 11, 1, 23, 59)), "2026-12-01", ok("日期串用本地日期"));

  // ---- loadSkipDates: inline ----
  const inline = loadSkipDates({ kind: "inline", dates: ["2026-12-01", "bogus", "2026-02-31"] }, root);
  assert.equal(inline.size, 1, ok("inline 只收合法日期"));
  assert.equal(inline.has("2026-12-01"), true, ok("inline 命中"));

  // ---- loadSkipDates: file ----
  const listFile = join(root, "skip.txt");
  writeFileSync(
    listFile,
    ["# 注释行", "", "2026-12-01", "2026-12-02  # 行内注释", "坏值"].join("\n"),
    "utf8",
  );
  const fromFile = loadSkipDates({ kind: "file", path: "skip.txt" }, root);
  assert.equal(fromFile.size, 2, ok("文件清单只收合法日期"));
  assert.equal(fromFile.has("2026-12-01"), true, ok("文件清单第一行"));
  assert.equal(fromFile.has("2026-12-02"), true, ok("行内注释不影响解析"));

  // 文件不存在 → 空集合（不报错、不阻止任务）
  assert.equal(loadSkipDates({ kind: "file", path: "nope.txt" }, root).size, 0, ok("清单文件不存在时返回空集合"));
  assert.equal(loadSkipDates(undefined, root).size, 0, ok("无来源返回空集合"));

  // ---- evaluateGate: 无门控 = 执行 ----
  assert.equal(evaluateGate(undefined, { cwd: root, now: new Date() }).kind, "run", ok("无门控直接执行"));

  // ---- evaluateGate: 日期命中 → skip ----
  const holidayObj = new Date(2026, 11, 1, 9, 0);
  const hit = evaluateGate({ skipDates: { kind: "inline", dates: ["2026-12-01"] } }, { cwd: root, now: holidayObj });
  assert.equal(hit.kind, "skip", ok("日期命中 → 跳过"));
  assert.match(hit.reason, /跳过日期/, ok("跳过原因说明是日期命中"));

  const miss = evaluateGate({ skipDates: { kind: "inline", dates: ["2026-12-02"] } }, { cwd: root, now: holidayObj });
  assert.equal(miss.kind, "run", ok("日期未命中 → 执行"));

  // ---- evaluateGate: 前置条件命令 ----
  const passGate = evaluateGate(
    { precondition: { command: nodeCmd, args: ["-e", "process.exit(0)"] } },
    { cwd: root, now: new Date() },
  );
  assert.equal(passGate.kind, "run", ok("前置条件退出 0 → 执行"));

  const failGate = evaluateGate(
    { precondition: { command: nodeCmd, args: ["-e", "process.exit(2)"] } },
    { cwd: root, now: new Date() },
  );
  assert.equal(failGate.kind, "skip", ok("前置条件非 0 → 跳过（不是失败）"));
  assert.match(failGate.reason, /前置条件不满足/, ok("跳过原因说明是前置条件"));
  assert.match(failGate.reason, /退出码 2/, ok("原因里带退出码"));

  // 命令不存在 → 跳过（保守：无人值守不硬闯）
  const missing = evaluateGate({ precondition: { command: "definitely-not-real-xyz" } }, { cwd: root, now: new Date() });
  assert.equal(missing.kind, "skip", ok("命令无法执行 → 跳过"));

  // 空命令
  assert.equal(evaluateGate({ precondition: { command: "  " } }, { cwd: root, now: new Date() }).kind, "skip", ok("空命令 → 跳过"));

  // 命令在 cwd 下执行
  writeFileSync(join(root, "marker.txt"), "x", "utf8");
  const cwdCheck = evaluateGate(
    {
      precondition: {
        command: nodeCmd,
        args: ["-e", "process.exit(require('fs').existsSync('marker.txt')?0:7)"],
      },
    },
    { cwd: root, now: new Date() },
  );
  assert.equal(cwdCheck.kind, "run", ok("前置条件在任务 cwd 下执行"));

  // ---- 顺序：日期命中时不去跑命令 ----
  // 用一个「必然让进程留下痕迹」的命令验证它没被执行
  const sideEffect = join(root, "should-not-exist.txt");
  const ordered = evaluateGate(
    {
      skipDates: { kind: "inline", dates: [localDateString(new Date())] },
      precondition: {
        command: nodeCmd,
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(sideEffect)}, 'x')`],
      },
    },
    { cwd: root, now: new Date() },
  );
  assert.equal(ordered.kind, "skip", ok("日期命中时跳过"));
  const fsMod = await import("node:fs");
  assert.equal(fsMod.existsSync(sideEffect), false, ok("日期命中时前置命令没有被执行（省掉昂贵查询）"));

  // ---- 两个条件都通过 → 执行 ----
  const both = evaluateGate(
    {
      skipDates: { kind: "inline", dates: ["2027-01-01"] },
      precondition: { command: nodeCmd, args: ["-e", "process.exit(0)"] },
    },
    { cwd: root, now: new Date(2026, 11, 1) },
  );
  assert.equal(both.kind, "run", ok("日期未命中且前置条件通过 → 执行"));

  // ---- describeGate ----
  assert.equal(describeGate(undefined, "zh"), "不门控", ok("描述：中文无门控"));
  assert.equal(describeGate(undefined, "en"), "No gate", ok("描述：英文无门控"));
  assert.match(
    describeGate({ precondition: { command: "check", args: ["--today"] } }, "zh"),
    /前置条件：check --today/,
    ok("描述：中文前置条件含参数"),
  );
  assert.match(
    describeGate({ skipDates: { kind: "inline", dates: ["2026-01-01", "2026-01-02"] } }, "en"),
    /Skip dates: 2 dates/,
    ok("描述：英文跳过日期计数"),
  );
  assert.match(
    describeGate({ skipDates: { kind: "file", path: "dates.txt" } }, "zh"),
    /dates\.txt/,
    ok("描述：文件来源显示路径"),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`automation-gate ok (${checks} 项断言通过)`);
