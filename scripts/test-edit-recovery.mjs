import assert from "node:assert/strict";
import { register } from "node:module";

// 源码用 bundler 风格的无扩展名导入，这里替 node 解析。
register(new URL("./ts-ext-loader.mjs", import.meta.url));

// 该 ext 只依赖 Node 内置，但 import type 会被剥离；这里直接 import 其导出函数。
const { findClosest, renderHint, fixDrivePath } = await import("../src/main/mpi-edit-recovery-ext.ts");

// ---------------------------------------------------------------------------
// 样本全部取自 2026-11-10 真实失败会话（Hdec.CatalogAudit：
// 72 次 edit / 15 次失败，逐条核对后确认 oldText 从未出现在已读片段里）
// ---------------------------------------------------------------------------

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
}

console.log("edit-recovery: findClosest");

// 案例 1：变量名不一致（idx571，实测 `foreach (TargetRow r in allRows)`）
ok("认出变量名差异并定位到正确行", () => {
  const file = [
    "class X {",
    "  void Apply(...) {",
    "    // 别的代码",
    "    var exact = new Dictionary<string, List<TargetRow>>(StringComparer.OrdinalIgnoreCase);",
    "    foreach (TargetRow row in allRows)",
    "    {",
    "        if (!string.Equals(row.PageKey, pageKey)) continue;",
    "    }",
    "  }",
    "}",
  ].join("\n");
  const oldText = [
    "    foreach (TargetRow r in allRows)",
    "    {",
    "        if (!string.Equals(r.PageKey, pageKey)) continue;",
    "    }",
  ].join("\n");

  const hit = findClosest(file, oldText);
  assert.ok(hit, "应当找到候选");
  assert.equal(hit.startLine, 5, `起始行应为 5，实际 ${hit.startLine}`);
  assert.ok(hit.score > 0.5, `相似度应 > 0.5，实际 ${hit.score}`);
  // 差异里应当点出 row vs r
  const diffs = hit.diffs.map((d) => d.actual).join("\n");
  assert.ok(diffs.includes("row"), "差异里应出现文件实际内容");
});

// 案例 2：整段缩进差异（模型常见错误）
ok("缩进不同也能定位", () => {
  const file = "function f() {\n        if (x) {\n            doThing();\n        }\n}";
  const oldText = "if (x) {\n    doThing();\n}";
  const hit = findClosest(file, oldText);
  assert.ok(hit, "应当找到候选");
  assert.ok(hit.score > 0.7, `相似度应 > 0.7，实际 ${hit.score}`);
});

// 案例 3：完全无关的文本 → 不提示（避免误导）
ok("无关文本不返回候选", () => {
  const file = "alpha beta gamma\ndelta epsilon";
  const oldText = "完全不同的中文内容\n一点都不像";
  const hit = findClosest(file, oldText);
  assert.equal(hit, null, "无关文本应当返回 null，而不是瞎猜一个位置");
});

// 案例 4：空 oldText 不应崩
ok("空 oldText 安全返回 null", () => {
  assert.equal(findClosest("a\nb", ""), null);
  assert.equal(findClosest("a\nb", "   "), null);
});

// 案例 5：CRLF 文件也能匹配（Windows 源码常态）
ok("CRLF 文件可匹配", () => {
  const file = "line one\r\n    readonly bool grid;\r\nline three";
  const hit = findClosest(file, "    readonly bool grid;");
  assert.ok(hit, "CRLF 应当能匹配");
  assert.equal(hit.startLine, 2);
});

// 案例 6：渲染出的提示必须含行号与「oldText 要逐字复制」的指引
ok("renderHint 带行号与指引", () => {
  const file = ["a", "b", "    readonly bool grid;", "d"].join("\n");
  const hit = findClosest(file, "    readonly bool gridd;");
  assert.ok(hit);
  const text = renderHint(hit, "Foo.cs");
  assert.ok(text.includes("Foo.cs"), "应含路径");
  assert.ok(/第 \d+–\d+ 行/.test(text), "应含行号区间");
  assert.ok(text.includes("逐字复制"), "应含逐字复制提示");
});

// 案例 7：长文件性能（防止在几千行文件上卡住）
ok("长文件不被拖垮", () => {
  const big = Array.from({ length: 3000 }, (_, i) => `    line number ${i} content here`).join("\n");
  const started = Date.now();
  const hit = findClosest(big, "    line number 1500 content herr");
  const elapsed = Date.now() - started;
  assert.ok(hit, "应当找到");
  assert.ok(elapsed < 5000, `耗时 ${elapsed}ms 应 < 5000ms`);
  console.log(`      （3000 行耗时 ${elapsed}ms）`);
});

// ---------------------------------------------------------------------------
// 路径写法：pi 的 normalizeWindowsShellPath 漏掉 /e:/ 与 e:/ 两种
// （2026-11-10 实测 72 次 edit 里 3 次因此 ENOENT）
// ---------------------------------------------------------------------------
console.log("\nedit-recovery: fixDrivePath");

ok("/e:/x 混合写法 → E:\\x", () => {
  assert.equal(fixDrivePath("/e:/MyWorkspace/a.cs"), "E:\\MyWorkspace\\a.cs");
});

ok("/e:x 无斜杠也认", () => {
  assert.equal(fixDrivePath("/e:MyWorkspace/a.cs"), "E:\\MyWorkspace\\a.cs");
});

ok("小写盘符 e:/x → E:\\x", () => {
  assert.equal(fixDrivePath("e:/MyWorkspace/a.cs"), "E:\\MyWorkspace\\a.cs");
});

ok("已正确的路径原样返回", () => {
  assert.equal(fixDrivePath("e:\\MyWorkspace\\a.cs"), "E:\\MyWorkspace\\a.cs");
  assert.equal(fixDrivePath("E:\\MyWorkspace\\a.cs"), "E:\\MyWorkspace\\a.cs");
});

ok("pi 已支持的 /e/x 不动（不抢它的活）", () => {
  assert.equal(fixDrivePath("/e/MyWorkspace/a.cs"), "/e/MyWorkspace/a.cs");
});

ok("占位符/相对路径不动（救不了的不假装能救）", () => {
  assert.equal(fixDrivePath("unused"), "unused");
  assert.equal(fixDrivePath("relative/path.cs"), "relative/path.cs");
});

// 回归：路径含 `.`（几乎每个源文件都有）时正则曾用 [^.]*? 导致静默不匹配，
// 实测 /e:/…/Sample.cs 因此没能触发修复——用例必须带点号。
ok("报错正则能匹配带点的路径", () => {
  const RE = /Could not (?:edit|find) file: (.+?)\. Error code: (ENOENT|EACCES)/;
  const m = RE.exec("Could not edit file: /e:/a/b/Sample.cs. Error code: ENOENT.");
  assert.ok(m, "带 .cs 的路径必须能匹配");
  assert.equal(m[1], "/e:/a/b/Sample.cs");
});

console.log(`\nedit-recovery: ${pass} 项全部通过`);
