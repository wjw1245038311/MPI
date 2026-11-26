// 产物校验（automation-verify.ts）单测。
//
// 背景：minibox 2026-11-26 邮件第 2 条——「成功」以前只看模型是否正常说完。
// 反例：review.py 在台账未回写时只打印「尚无持仓」，退出码 0，模型回一句
// 「跑完了」就算成功。这里钉住每种规则的正反两面。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { tmpdir } from "node:os";

register(new URL("./electron-stub-loader.mjs", import.meta.url));
const { checkRule, describeVerifyRule, resolveRulePath, runVerifyRules } = await import(
  "../src/main/automation-verify.ts"
);

let checks = 0;
const ok = (label) => {
  checks++;
  return label;
};

const root = mkdtempSync(join(tmpdir(), "mpi-verify-"));
const now = Date.now();

try {
  // ---- resolveRulePath：相对路径基于运行 cwd，不是进程 cwd ----
  assert.equal(resolveRulePath("out/report.html", root), join(root, "out/report.html"), ok("相对路径基于运行 cwd"));
  assert.equal(resolveRulePath("/abs/x.txt", root), "/abs/x.txt", ok("绝对路径原样保留"));

  // ---- exitCode ----
  assert.equal(checkRule({ kind: "exitCode", expected: 0 }, { cwd: root, exitCode: 0 }).ok, true, ok("退出码 0 通过"));
  const badExit = checkRule({ kind: "exitCode", expected: 0 }, { cwd: root, exitCode: 1 });
  assert.equal(badExit.ok, false, ok("退出码 1 不通过"));
  assert.match(badExit.reason, /退出码 1/, ok("失败信息含实际退出码"));
  assert.equal(checkRule({ kind: "exitCode", expected: 0 }, { cwd: root }).ok, false, ok("拿不到退出码记为失败（不静默放行）"));

  // ---- fileExists ----
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "report.html"), "<h1>ok</h1>", "utf8");
  assert.equal(checkRule({ kind: "fileExists", path: "out/report.html" }, { cwd: root }).ok, true, ok("文件存在通过"));
  assert.equal(checkRule({ kind: "fileExists", path: "out/missing.html" }, { cwd: root }).ok, false, ok("文件缺失不通过"));
  // 目录也算存在
  assert.equal(checkRule({ kind: "fileExists", path: "out" }, { cwd: root }).ok, true, ok("目录存在也通过"));

  // ---- fileNewerThan ----
  assert.equal(
    checkRule({ kind: "fileNewerThan", path: "out/report.html" }, { cwd: root, startedAt: now - 60_000 }).ok,
    true,
    ok("mtime 晚于开始时刻通过"),
  );
  assert.equal(
    checkRule({ kind: "fileNewerThan", path: "out/report.html" }, { cwd: root, startedAt: now + 60_000 }).ok,
    false,
    ok("mtime 早于开始时刻不通过（这次没写文件）"),
  );
  // 没给基准时退化为「存在即可」——否则给旧任务加规则会一次性全红
  assert.equal(
    checkRule({ kind: "fileNewerThan", path: "out/report.html" }, { cwd: root }).ok,
    true,
    ok("无 startedAt 基准时退化为存在检查"),
  );
  assert.equal(checkRule({ kind: "fileNewerThan", path: "out/none.html" }, { cwd: root, startedAt: now }).ok, false, ok("fileNewerThan 文件缺失时不通过"));
  // mtime 容差 2s：mtime 比 startedAt 早 1s 仍算通过
  const f = join(root, "out", "tolerance.txt");
  writeFileSync(f, "x", "utf8");
  const t = Math.floor((now - 1000) / 1000);
  utimesSync(f, t, t);
  assert.equal(
    checkRule({ kind: "fileNewerThan", path: "out/tolerance.txt" }, { cwd: root, startedAt: now }).ok,
    true,
    ok("2 秒时钟容差内仍通过"),
  );

  // ---- fileContains ----
  assert.equal(
    checkRule({ kind: "fileContains", path: "out/report.html", text: "<h1>" }, { cwd: root }).ok,
    true,
    ok("包含指定内容通过"),
  );
  assert.equal(
    checkRule({ kind: "fileContains", path: "out/report.html", text: "不存在的串" }, { cwd: root }).ok,
    false,
    ok("不包含指定内容不通过"),
  );
  assert.equal(
    checkRule({ kind: "fileContains", path: "out/none.html", text: "x" }, { cwd: root }).ok,
    false,
    ok("fileContains 文件缺失时不通过"),
  );

  // ---- minBytes ----
  assert.equal(checkRule({ kind: "minBytes", path: "out/report.html", bytes: 5 }, { cwd: root }).ok, true, ok("字节数达标通过"));
  assert.equal(checkRule({ kind: "minBytes", path: "out/report.html", bytes: 10_000 }, { cwd: root }).ok, false, ok("字节数不足不通过"));
  const byteFail = checkRule({ kind: "minBytes", path: "out/report.html", bytes: 10_000 }, { cwd: root });
  assert.match(byteFail.reason, /10,?000|字节/, ok("失败信息含阈值"));

  // ---- command ----
  // 用当前 node 跑一个必然成功的脚本（不依赖 shell 命令是否存在）
  const cmdOk = checkRule(
    { kind: "command", command: process.execPath, args: ["-e", "process.exit(0)"] },
    { cwd: root },
  );
  assert.equal(cmdOk.ok, true, ok("命令退出 0 通过"));
  const cmdFail = checkRule(
    { kind: "command", command: process.execPath, args: ["-e", "process.exit(3)"] },
    { cwd: root },
  );
  assert.equal(cmdFail.ok, false, ok("命令退出非 0 不通过"));
  assert.match(cmdFail.reason, /退出码 3/, ok("命令失败信息含退出码"));
  const cmdMissing = checkRule({ kind: "command", command: "definitely-not-a-real-binary-xyz" }, { cwd: root });
  assert.equal(cmdMissing.ok, false, ok("命令不存在时不通过"));
  const cmdEmpty = checkRule({ kind: "command", command: "   " }, { cwd: root });
  assert.equal(cmdEmpty.ok, false, ok("空命令不通过"));
  // 命令在 cwd 下执行
  const cmdCwd = checkRule(
    { kind: "command", command: process.execPath, args: ["-e", "process.exit(require('fs').existsSync('out/report.html')?0:9)"] },
    { cwd: root },
  );
  assert.equal(cmdCwd.ok, true, ok("命令在运行 cwd 下执行"));

  // ---- runVerifyRules：AND 语义 ----
  const rules = [
    { kind: "fileExists", path: "out/report.html" },
    { kind: "minBytes", path: "out/report.html", bytes: 1 },
  ];
  assert.equal(runVerifyRules(rules, { cwd: root }).ok, true, ok("全部规则通过"));
  const mixed = [
    { kind: "fileExists", path: "out/report.html" },
    { kind: "fileExists", path: "out/missing.html" },
    { kind: "exitCode", expected: 0 },
  ];
  assert.equal(runVerifyRules(mixed, { cwd: root, exitCode: 0 }).ok, false, ok("任一规则不过即失败"));
  assert.equal(runVerifyRules([], { cwd: root }).ok, true, ok("空规则列表视为通过（不校验）"));
  // 失败时返回的是第一个失败规则
  const first = runVerifyRules(mixed, { cwd: root, exitCode: 0 });
  assert.equal(first.rule.kind, "fileExists", ok("返回第一个失败规则"));
  assert.match(first.rule.path, /missing/, ok("是缺失的那个文件"));

  // ---- 未知规则类型 ----
  const unknown = checkRule({ kind: "no-such-kind" }, { cwd: root });
  assert.equal(unknown.ok, false, ok("未知规则类型记为失败（不静默放行）"));

  // ---- describeVerifyRule ----
  assert.equal(describeVerifyRule({ kind: "exitCode", expected: 0 }, "zh"), "退出码 = 0", ok("描述：中文退出码"));
  assert.equal(describeVerifyRule({ kind: "exitCode", expected: 0 }, "en"), "exit code = 0", ok("描述：英文退出码"));
  assert.match(describeVerifyRule({ kind: "minBytes", path: "a", bytes: 100 }, "zh"), /100/, ok("描述：中文字节数"));
  assert.match(
    describeVerifyRule({ kind: "command", command: "npm", args: ["test"] }, "en"),
    /npm test/,
    ok("描述：带参数的命令"),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`automation-verify ok (${checks} 项断言通过)`);
