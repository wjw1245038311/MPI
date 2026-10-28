import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 秘密执行中介（P2）的 L1：策略三分支、脱敏回填、幂等、超时上限、回执清扫。 */
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const broker = await import("../src/main/secret-broker.ts");

const dir = mkdtempSync(join(tmpdir(), "mpi-secret-broker-"));
const dirs = broker.ensureSecretBrokerDirs(dir);
const SECRET = "P@ssw0rd-very-secret";
const TEST_CWD = process.cwd();

/** 假执行器：记录调用参数，按预设返回。 */
function makeRunner(result = { exitCode: 0, stdout: "done", stderr: "" }) {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    return typeof result === "function" ? result(args) : result;
  };
  return { calls, runner };
}

const auditLog = [];
const audit = (entry) => auditLog.push(entry);

const lookupTable = {
  "confirm-one": { name: "confirm-one", level: "confirm", value: SECRET },
  "local-one": { name: "local-one", level: "local-only", value: SECRET },
  "silent-one": { name: "silent-one", level: "silent", value: SECRET },
};
const lookup = (name) => lookupTable[name] ?? null;

function dropRequest(req) {
  writeFileSync(join(dirs.inboxDir, `${req.id}.json`), JSON.stringify(req));
}

function readReceipt(id) {
  const file = join(dirs.outboxDir, `${id}.json`);
  assert.ok(existsSync(file), `回执应存在：${id}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

const baseOptions = (extra = {}) => ({
  ...dirs,
  cwd: TEST_CWD,
  source: { kind: "desktop" },
  lookup,
  audit,
  ...extra,
});

try {
  // --- 1) 正常执行：值只进子进程 env，请求被消费，回执 ok ---
  {
    const { calls, runner } = makeRunner({ exitCode: 0, stdout: "server restarted", stderr: "" });
    dropRequest({ id: "r1", name: "confirm-one", command: "systemctl restart app", threadId: "th-1" });
    const handled = await broker.ingestSecretRequests(baseOptions({ runner }));
    assert.equal(handled, 1, "处理一个请求");
    assert.equal(calls.length, 1, "执行一次");
    assert.equal(calls[0].env.MPI_SECRET_VALUE, SECRET, "值通过 env 传入");
    assert.equal(calls[0].command, "systemctl restart app");
    assert.equal(calls[0].cwd, TEST_CWD, "默认用线程 cwd");
    const receipt = readReceipt("r1");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.stdout, "server restarted");
    assert.equal(receipt.redacted, undefined, "没出现值就不标记脱敏");
    assert.equal(existsSync(join(dirs.inboxDir, "r1.json")), false, "请求处理后被删");
    assert.ok(auditLog.some((e) => e.action === "exec" && e.name === "confirm-one"));
    assert.equal(JSON.stringify(auditLog).includes(SECRET), false, "审计不含值");
  }

  // --- 2) 输出里出现凭据值 → 回填脱敏 ---
  {
    const { runner } = makeRunner(() => ({ exitCode: 0, stdout: `login with ${SECRET} ok`, stderr: `warn ${SECRET}` }));
    dropRequest({ id: "r2", name: "confirm-one", command: "echo $MPI_SECRET_VALUE" });
    await broker.ingestSecretRequests(baseOptions({ runner }));
    const receipt = readReceipt("r2");
    assert.equal(receipt.redacted, true, "标记已脱敏");
    assert.equal(receipt.stdout.includes(SECRET), false, "stdout 里没有明文");
    assert.equal(receipt.stderr.includes(SECRET), false, "stderr 里没有明文");
    assert.ok(receipt.stdout.includes("***"));
  }

  // --- 3) 凭据不存在 ---
  {
    const { calls, runner } = makeRunner();
    dropRequest({ id: "r3", name: "nope", command: "id" });
    await broker.ingestSecretRequests(baseOptions({ runner }));
    assert.equal(calls.length, 0, "没有凭据不执行");
    assert.equal(readReceipt("r3").error, "NO_CREDENTIAL");
  }

  // --- 4) local-only + 远程来源 → 拒绝；桌面来源 → 放行 ---
  {
    const { calls, runner } = makeRunner();
    dropRequest({ id: "r4", name: "local-one", command: "id" });
    await broker.ingestSecretRequests(
      baseOptions({ runner, source: { kind: "remote", deviceId: "dev-12345678" } }),
    );
    assert.equal(calls.length, 0, "远程不放行 local-only");
    assert.equal(readReceipt("r4").error, "DENIED_LOCAL_ONLY");

    dropRequest({ id: "r4b", name: "local-one", command: "id" });
    await broker.ingestSecretRequests(baseOptions({ runner, source: { kind: "desktop" } }));
    assert.equal(calls.length, 1, "桌面放行 local-only");
    assert.equal(readReceipt("r4b").ok, true);
  }

  // --- 5) 空命令 ---
  {
    dropRequest({ id: "r5", name: "confirm-one", command: "   " });
    await broker.ingestSecretRequests(baseOptions({ runner: makeRunner().runner }));
    assert.equal(readReceipt("r5").error, "EMPTY_COMMAND");
  }

  // --- 6) 幂等：同一 id 已有回执 → 不再执行 ---
  {
    const { calls, runner } = makeRunner();
    dropRequest({ id: "r1", name: "confirm-one", command: "again" }); // r1 已有回执
    const handled = await broker.ingestSecretRequests(baseOptions({ runner }));
    assert.equal(calls.length, 0, "已有回执的请求不重复执行");
    assert.equal(handled, 0);
  }

  // --- 7) 超时上限：请求给的超时被夹到 10 分钟 ---
  {
    const { calls, runner } = makeRunner();
    dropRequest({ id: "r7", name: "confirm-one", command: "sleep 1", timeoutMs: 99_999_999 });
    await broker.ingestSecretRequests(baseOptions({ runner }));
    assert.equal(calls[0].timeoutMs, 600_000, "超时夹到 10 分钟");
  }

  // --- 8) resolveContext 覆盖来源（多线程共用收件箱）---
  {
    const { calls, runner } = makeRunner();
    dropRequest({ id: "r8", name: "local-one", command: "id", threadId: "th-remote" });
    await broker.ingestSecretRequests(
      baseOptions({
        runner,
        resolveContext: (req) => ({
          cwd: TEST_CWD,
          source: req.threadId === "th-remote" ? { kind: "remote", deviceId: "dev-99999999" } : { kind: "desktop" },
        }),
      }),
    );
    assert.equal(calls.length, 0, "resolveContext 判定为远程 → 拒绝");
    assert.equal(readReceipt("r8").error, "DENIED_LOCAL_ONLY");
  }

  // --- 9) 执行器抛错 → SPAWN_FAILED ---
  {
    const runner = async () => {
      throw new Error("boom");
    };
    dropRequest({ id: "r9", name: "confirm-one", command: "id" });
    await broker.ingestSecretRequests(baseOptions({ runner }));
    const receipt = readReceipt("r9");
    assert.equal(receipt.ok, false);
    assert.match(String(receipt.error), /SPAWN_FAILED/);
  }

  // --- 10) 坏请求文件被清掉，不卡队列 ---
  {
    writeFileSync(join(dirs.inboxDir, "broken.json"), "{not json");
    const { runner } = makeRunner();
    await broker.ingestSecretRequests(baseOptions({ runner }));
    assert.equal(existsSync(join(dirs.inboxDir, "broken.json")), false, "坏文件被删除");
  }

  // --- 11) 回执清扫：超期删除，新回执保留 ---
  {
    const old = join(dirs.outboxDir, "old.json");
    writeFileSync(old, "{}");
    const past = (Date.now() - 31 * 60 * 1000) / 1000;
    utimesSync(old, past, past);
    const removed = broker.sweepSecretReceipts(dirs.outboxDir);
    assert.equal(removed, 1, "只删超期的");
    assert.equal(existsSync(old), false);
    assert.ok(readdirSync(dirs.outboxDir).length > 0, "新回执还在");
  }

  // --- 12) redactValue 边界：短值/无命中不误伤 ---
  {
    assert.deepEqual(broker.redactValue("abc", "abc"), { text: "abc", redacted: false }, "过短的值不脱敏");
    assert.deepEqual(broker.redactValue("hello", "world"), { text: "hello", redacted: false });
    assert.deepEqual(broker.redactValue("x SECRETVALUE y", "SECRETVALUE"), { text: "x *** y", redacted: true });
  }

  console.log("secret-broker: all assertions passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
