import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 凭据库 P1a 的 L1 用例：校验、唯一名、fail-closed 加密、明文不落盘、审计、reveal 统计。 */
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig } = await import("../src/main/config.ts");
const store = await import("../src/main/credentials-store.ts");

const dataDir = mkdtempSync(join(tmpdir(), "mpi-credentials-"));
const vault = () => join(dataDir, "credentials.json");
const audit = () => join(dataDir, "credentials-audit.jsonl");
const SECRET = "s3cr3t-ünicode-P@ss";

/** 假 cipher：可辨识的前缀 + 反向字符串（不引入 electron，也不依赖真实 DPAPI）。 */
const fakeCipher = {
  available: () => true,
  encrypt: (plain) => `enc:fake:${Buffer.from(plain, "utf8").toString("base64")}`,
  decrypt: (blob) => Buffer.from(blob.replace(/^enc:fake:/, ""), "base64").toString("utf8"),
};

try {
  loadConfig(dataDir);
  store.configureCredentialCipher(fakeCipher);

  // --- 空库 ---
  assert.deepEqual(store.listCredentials(), [], "新库为空");
  assert.equal(existsSync(vault()), false, "空库不预先建文件");

  // --- 新增 ---
  const created = store.createCredential({
    name: "aliyun-prod-root",
    kind: "password",
    level: "confirm",
    hint: "部署机，仅 sudo 用",
    value: SECRET,
  });
  assert.equal(created.name, "aliyun-prod-root");
  assert.equal(created.level, "confirm");
  assert.equal(created.useCount, 0);
  assert.deepEqual(created.scope, { type: "global" });
  assert.equal("value" in created, false, "列表视图不含值");
  assert.equal("valueEnc" in created, false, "列表视图不含密文");

  // 明文绝不落盘、密文可逆
  const raw = readFileSync(vault(), "utf8");
  assert.equal(raw.includes(SECRET), false, "磁盘上搜不到明文");
  assert.equal(raw.includes("enc:fake:"), true, "值以密文形式存储");

  // --- 校验 ---
  const expectCode = (fn, code, label) => {
    try {
      fn();
      assert.fail(`${label}：应当抛 ${code}`);
    } catch (err) {
      assert.equal(err?.code, code, `${label}：期望 ${code}，实际 ${err?.code}`);
    }
  };
  expectCode(() => store.createCredential({ name: "aliyun-prod-root", kind: "password", level: "silent", value: "x" }), "CRED_NAME_TAKEN", "重名");
  expectCode(() => store.createCredential({ name: "Bad Name", kind: "password", level: "silent", value: "x" }), "CRED_NAME_INVALID", "非法名");
  expectCode(() => store.createCredential({ name: "ok-name", kind: "password", level: "silent", value: "" }), "CRED_VALUE_EMPTY", "空值");
  expectCode(() => store.createCredential({ name: "ok-name", kind: "bogus", level: "silent", value: "x" }), "CRED_KIND_INVALID", "非法类型");
  expectCode(() => store.createCredential({ name: "ok-name", kind: "password", level: "bogus", value: "x" }), "CRED_LEVEL_INVALID", "非法级别");
  expectCode(
    () => store.createCredential({ name: "ok-name", kind: "password", level: "silent", value: "x", scope: { type: "project", root: "  " } }),
    "CRED_SCOPE_INVALID",
    "项目作用域缺 root",
  );

  // --- 更新（不传 value 时保留原值）---
  const projScope = { type: "project", root: "E:/MyWorkspace/Project/MPI" };
  const updated = store.updateCredential(created.id, { level: "local-only", scope: projScope, hint: null });
  assert.equal(updated.level, "local-only");
  assert.deepEqual(updated.scope, projScope);
  assert.equal(updated.hint, undefined, "hint:null 清空说明");
  assert.equal(store.revealCredential(created.id).value, SECRET, "未传 value 时保留原值");

  // 传 value 时替换
  store.updateCredential(created.id, { value: "new-secret" });
  assert.equal(store.revealCredential(created.id).value, "new-secret");

  // --- reveal 统计 ---
  const before = store.listCredentials().find((c) => c.id === created.id);
  assert.ok(before.lastUsedAt && before.useCount >= 1, "reveal 会记录使用时间与次数");
  store.revealCredential(created.id);
  assert.equal(
    store.listCredentials().find((c) => c.id === created.id).useCount,
    before.useCount + 1,
    "useCount 递增",
  );

  // --- 审计：只含名字与动作，不含值 ---
  const auditLines = readFileSync(audit(), "utf8").trim().split("\n");
  const actions = auditLines.map((l) => JSON.parse(l).action);
  assert.ok(actions.includes("create") && actions.includes("update") && actions.includes("reveal"), "审计含 create/update/reveal");
  assert.equal(readFileSync(audit(), "utf8").includes(SECRET), false, "审计不含明文");
  assert.equal(readFileSync(audit(), "utf8").includes("new-secret"), false, "审计不含更新后的明文");

  // --- fail-closed：加密不可用时拒绝写入，且文件不变 ---
  const snapshotBefore = readFileSync(vault(), "utf8");
  store.configureCredentialCipher({ ...fakeCipher, available: () => false });
  expectCode(
    () => store.createCredential({ name: "no-crypto", kind: "token", level: "silent", value: "x" }),
    "CRED_ENCRYPTION_UNAVAILABLE",
    "加密不可用时应拒绝",
  );
  assert.equal(readFileSync(vault(), "utf8"), snapshotBefore, "被拒绝时文件未被改写");
  store.configureCredentialCipher(fakeCipher);

  // --- 删除 ---
  assert.equal(store.deleteCredential(created.id), true);
  assert.deepEqual(store.listCredentials(), [], "删除后为空");
  expectCode(() => store.revealCredential(created.id), "CRED_NOT_FOUND", "删除后 reveal");
  expectCode(() => store.deleteCredential(created.id), "CRED_NOT_FOUND", "重复删除");

  // -----------------------------------------------------------------------
  // P1b：silent 级凭据 → 环境变量注入（confirm / local-only 绝不能提前注入）
  // -----------------------------------------------------------------------
  const shared = await import("../src/shared/credentials.ts");
  assert.equal(shared.secretEnvName("aliyun-prod-root"), "MPI_SECRET_ALIYUN_PROD_ROOT", "变量名映射");
  assert.equal(shared.secretEnvName("a.b_c"), "MPI_SECRET_A_B_C", "非字母数字统一成下划线");

  const projectRoot = "E:/MyWorkspace/Project/MPI";
  store.createCredential({ name: "silent-global", kind: "token", level: "silent", hint: "只读查询", value: "g-123" });
  store.createCredential({ name: "silent-project", kind: "password", level: "silent", value: "p-456", scope: { type: "project", root: projectRoot } });
  store.createCredential({ name: "confirm-one", kind: "password", level: "confirm", value: "c-789" });
  store.createCredential({ name: "local-one", kind: "password", level: "local-only", value: "l-000" });

  const forProject = store.secretEnvForScope(projectRoot);
  assert.equal(forProject.env.MPI_SECRET_SILENT_GLOBAL, "g-123", "全局 silent 注入");
  assert.equal(forProject.env.MPI_SECRET_SILENT_PROJECT, "p-456", "项目 silent 注入（根匹配）");
  assert.equal("MPI_SECRET_CONFIRM_ONE" in forProject.env, false, "confirm 级不得提前注入");
  assert.equal("MPI_SECRET_LOCAL_ONE" in forProject.env, false, "local-only 不得提前注入");

  // P1c：没注入的凭据要带原因，模型才能说清「为什么用不了」
  const blockedOf = (res, name) => res.blocked.find((b) => b.name === name);
  assert.equal(blockedOf(forProject, "confirm-one")?.reason, "level-confirm", "confirm 级原因");
  assert.equal(blockedOf(forProject, "local-one")?.reason, "level-local-only", "local-only 级原因");
  assert.equal(blockedOf(forProject, "silent-project"), undefined, "已注入的不会出现在 blocked 里");

  // 作用域：别的项目根只拿到全局那份（Windows 大小写/斜杠不敏感）
  const otherProject = store.secretEnvForScope("e:\\Other\\Project");
  assert.equal("MPI_SECRET_SILENT_GLOBAL" in otherProject.env, true, "全局仍适用");
  assert.equal("MPI_SECRET_SILENT_PROJECT" in otherProject.env, false, "项目作用域不跨项目");
  assert.equal(blockedOf(otherProject, "silent-project")?.reason, "scope", "跨项目时给出 scope 原因");
  assert.equal("MPI_SECRET_SILENT_GLOBAL" in store.secretEnvForScope(`${projectRoot}\\`).env, true, "尾斜杠不影响匹配");

  // meta 不含值，提示块也不含值
  assert.equal(JSON.stringify(forProject.meta).includes("g-123"), false, "meta 不含值");
  assert.equal(forProject.meta.find((m) => m.env === "MPI_SECRET_SILENT_GLOBAL")?.hint, "只读查询");
  for (const lang of [true, false]) {
    const block = shared.buildSecretEnvBlock(forProject.meta, forProject.blocked, lang);
    assert.ok(block.includes("MPI_SECRET_SILENT_GLOBAL"), "提示块列出变量名");
    assert.equal(block.includes("g-123"), false, "提示块不含值");
    assert.equal(block.includes("p-456"), false, "提示块不含值（项目凭据）");
    assert.ok(block.includes("confirm-one"), "提示块列出不可用凭据的名字");
    assert.ok(block.includes("local-one"), "同上（local-only）");
  }
  assert.equal(shared.buildSecretEnvBlock([], [], true), "", "没有可用也没有不可用时不加块");
  assert.ok(shared.buildSecretEnvBlock([], forProject.blocked, true).includes("没有"), "只有不可用时也给出提示");

  // P1c：spawn 时的注入决策要留一条审计（只记名字与原因）
  store.auditCredentialInjection({ threadId: "th-1", root: projectRoot, injected: forProject.meta.map((m) => m.name), blocked: forProject.blocked });
  const injectLine = readFileSync(audit(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.action === "inject")
    .pop();
  assert.equal(injectLine.threadId, "th-1");
  assert.deepEqual(injectLine.injected.sort(), ["silent-global", "silent-project"], "审计记下注入了哪些");
  assert.equal(injectLine.blocked.find((b) => b.name === "confirm-one")?.reason, "level-confirm", "审计记下被挡的原因");
  assert.equal(JSON.stringify(injectLine).includes("g-123"), false, "审计不含值");

  // P1c：prompt 来源记录（P2 确认卡片与审计的地基）
  const ps = await import("../src/main/prompt-source.ts");
  ps.__clearPromptSources();
  ps.notePromptSource("th-1", { kind: "remote", deviceId: "dev-abcdef123456" });
  assert.equal(ps.lastPromptSource("th-1")?.kind, "remote");
  assert.equal(ps.promptSourceTag(ps.lastPromptSource("th-1")), "remote:dev-abcd", "标签截断设备 id");
  assert.equal(ps.lastPromptSource("th-2"), undefined, "未记录的线程为 undefined");
  ps.notePromptSource("th-1", undefined);
  assert.equal(ps.lastPromptSource("th-1")?.kind, "remote", "undefined 不会覆盖已有记录");

  console.log("credentials-store: all assertions passed");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
