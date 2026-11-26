// 可写路径白名单（gate-write-allow.ts）单测。
//
// 这是安全关键模块：白名单等于给无人值守任务一条绕过门禁的持久通道，
// 所以边界比功能更重要。下面每条「必须拒绝」都是刻意的。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

register(new URL("./electron-stub-loader.mjs", import.meta.url));
const {
  MAX_WRITE_ALLOW_ENTRIES,
  createWriteAllowFile,
  globToRegExp,
  pathIsAllowed,
  readWriteAllowFile,
  removeWriteAllowFile,
  sanitizeWriteAllowEntry,
  sanitizeWriteAllowList,
} = await import("../src/main/gate-write-allow.ts");

let checks = 0;
const ok = (label) => {
  checks++;
  return label;
};

const cwd = "E:\\MyWorkspace\\Project\\App";
const dataDir = mkdtempSync(join(tmpdir(), "mpi-writeallow-"));

try {
  // ---- sanitizeWriteAllowEntry：接受 ----
  assert.equal(sanitizeWriteAllowEntry("reports/*.md", cwd), "reports/*.md", ok("相对 glob 可接受"));
  assert.equal(sanitizeWriteAllowEntry("reports/**", cwd), "reports/**", ok("跨层 glob 可接受"));
  assert.equal(sanitizeWriteAllowEntry("E:\\Agent\\ledger.json", cwd), "E:/Agent/ledger.json", ok("绝对路径可接受（反斜杠归一）"));
  assert.equal(sanitizeWriteAllowEntry("  data/out.txt  ", cwd), "data/out.txt", ok("首尾空白被裁掉"));

  // ---- 必须拒绝 ----
  assert.equal(sanitizeWriteAllowEntry("../../etc/passwd", cwd), null, ok("拒绝 ../ 上跳"));
  assert.equal(sanitizeWriteAllowEntry("a/../../b", cwd), null, ok("拒绝中段 ../ 上跳"));
  assert.equal(sanitizeWriteAllowEntry("C:\\a\\..\\..\\b", cwd), null, ok("拒绝绝对路径里的 .."));
  assert.equal(sanitizeWriteAllowEntry("~/secrets", cwd), null, ok("拒绝 ~ 展开（门禁无法预判落点）"));
  assert.equal(sanitizeWriteAllowEntry("", cwd), null, ok("拒绝空串"));
  assert.equal(sanitizeWriteAllowEntry("x".repeat(400), cwd), null, ok("拒绝超长条目"));
  assert.equal(sanitizeWriteAllowEntry(123, cwd), null, ok("拒绝非字符串"));

  // ---- 敏感路径即使在白名单里也拒绝 ----
  for (const bad of [
    ".git/config",
    "repo/.git/hooks/pre-commit",
    ".ssh/id_rsa",
    ".env",
    ".env.local",
    "certs/server.pem",
    "id_ed25519",
    "credentials.json",
    "secrets.yaml",
    "C:/Windows/System32/drivers/etc/hosts",
    "C:/ProgramData/secret.txt",
  ]) {
    assert.equal(sanitizeWriteAllowEntry(bad, cwd), null, ok(`拒绝敏感路径：${bad}`));
  }

  // ---- 批量规整 ----
  const list = sanitizeWriteAllowList(
    ["reports/*.md", "reports/*.md", "../bad", ".git/x", "data/**", ""],
    cwd,
  );
  assert.deepEqual(list, ["reports/*.md", "data/**"], ok("批量：去重、剔除非法、保持顺序"));
  assert.equal(sanitizeWriteAllowList(undefined, cwd).length, 0, ok("批量：非数组返回空"));
  const flood = sanitizeWriteAllowList(Array.from({ length: 80 }, (_, i) => `p${i}.txt`), cwd);
  assert.equal(flood.length, MAX_WRITE_ALLOW_ENTRIES, ok(`批量：条数上限 ${MAX_WRITE_ALLOW_ENTRIES}`));

  // ---- globToRegExp ----
  assert.equal(globToRegExp("reports/*.md").test("reports/a.md"), true, ok("glob: * 匹配单层文件"));
  assert.equal(globToRegExp("reports/*.md").test("reports/sub/a.md"), false, ok("glob: * 不跨层"));
  assert.equal(globToRegExp("reports/**").test("reports/sub/deep/a.md"), true, ok("glob: ** 跨层"));
  assert.equal(globToRegExp("reports/**").test("reports/a.md"), true, ok("glob: ** 含零层"));
  assert.equal(globToRegExp("a?.txt").test("ab.txt"), true, ok("glob: ? 单字符"));
  assert.equal(globToRegExp("a?.txt").test("abc.txt"), false, ok("glob: ? 不匹配多字符"));
  assert.equal(globToRegExp("a.b.txt").test("aXb.txt"), false, ok("glob: . 是字面点不是通配"));
  assert.equal(globToRegExp("A/B.MD").test("a/b.md"), true, ok("glob: 大小写不敏感"));

  // ---- pathIsAllowed ----
  const patterns = ["reports/*.md", "E:/Agent/ledger.json"];
  assert.equal(pathIsAllowed("E:\\MyWorkspace\\Project\\App\\reports\\x.md", patterns, cwd), true, ok("相对模式命中 cwd 下文件"));
  assert.equal(pathIsAllowed("E:\\MyWorkspace\\Project\\App\\reports\\sub\\x.md", patterns, cwd), false, ok("相对模式不跨层"));
  assert.equal(pathIsAllowed("E:\\Agent\\ledger.json", patterns, cwd), true, ok("绝对模式命中绝对路径"));
  assert.equal(pathIsAllowed("E:\\Agent\\other.json", patterns, cwd), false, ok("绝对模式未命中"));
  assert.equal(pathIsAllowed("E:\\MyWorkspace\\Project\\App\\reports\\x.md", [], cwd), false, ok("空白名单一律不放行"));
  // 敏感路径即使模式命中也不放行
  assert.equal(pathIsAllowed("E:\\MyWorkspace\\Project\\App\\.git\\config", [".git/**", "**"], cwd), false, ok("敏感路径即使匹配 ** 也不放行"));

  // ---- 文件读写往返 ----
  const file = createWriteAllowFile(dataDir, "task-1", patterns);
  const read = readWriteAllowFile(file);
  assert.deepEqual(read?.patterns, patterns, ok("白名单文件往返一致"));
  assert.equal(read?.taskId, "task-1", ok("文件里带 taskId（便于审计）"));
  assert.equal(read?.version, 1, ok("文件带 version"));
  removeWriteAllowFile(file);
  assert.equal(readWriteAllowFile(file), null, ok("删除后读不到"));
  // 删不存在的文件不抛
  removeWriteAllowFile(null);
  removeWriteAllowFile(file);
  checks++;

  // 损坏文件返回 null 而不是抛
  const broken = createWriteAllowFile(dataDir, "t", ["a"]);
  (await import("node:fs")).writeFileSync(broken, "{ not json", "utf8");
  assert.equal(readWriteAllowFile(broken), null, ok("损坏文件返回 null"));
  removeWriteAllowFile(broken);

  // 每次创建都是新文件名（避免多个并发任务共用一份）
  const f1 = createWriteAllowFile(dataDir, "t", ["a"]);
  const f2 = createWriteAllowFile(dataDir, "t", ["a"]);
  assert.notEqual(f1, f2, ok("并发任务各拿一份独立文件"));
  removeWriteAllowFile(f1);
  removeWriteAllowFile(f2);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`gate-write-allow ok (${checks} 项断言通过)`);
