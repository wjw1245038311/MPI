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

  console.log("credentials-store: all assertions passed");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
