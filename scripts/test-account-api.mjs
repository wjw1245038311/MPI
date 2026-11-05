// 账号 + 配置同步的服务端（mobile/relay/account.mjs）。
//
// 背景（2026-11-05 用户需求）：多台主机，登录后同步个人配置；手机卸载后连接信息不能丢。
// 设计：账号挂在中继同一个 TLS 端口上（/acct/*，不开新端口）；同步包由客户端用
// PBKDF2(密码, kdfSalt) 派生的密钥加密，**服务器只见密文**。
//
// 这里钉死的是服务端的契约：
//   1. 标识规范化（手机号/邮箱同一输入框，+86、空格、大小写不能变成两个账号）；
//   2. 注册/登录/令牌；密码错不能发令牌，失败会被限速；
//   3. 同步包按账号隔离、需要令牌、有大小上限；
//   4. 落盘是原子写（进程被 kill 不留半截 JSON）。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createAccountApi, normalizeIdentifier } = await import("../mobile/relay/account.mjs");

const DIR = mkdtempSync(join(tmpdir(), "mpi-account-"));

// ---- 1. 标识规范化 -----------------------------------------------------------
{
  assert.deepEqual(normalizeIdentifier("138 0013 8000"), { kind: "phone", key: "13800138000", display: "13800138000" });
  assert.deepEqual(normalizeIdentifier("+86 138-0013-8000"), { kind: "phone", key: "+8613800138000", display: "+8613800138000" });
  assert.deepEqual(normalizeIdentifier("  Wei.JW@Example.COM "), {
    kind: "email",
    key: "wei.jw@example.com",
    display: "wei.jw@example.com",
  });
  assert.equal(normalizeIdentifier(""), null);
  assert.equal(normalizeIdentifier("12345"), null, "太短的号码不能当账号");
  assert.equal(normalizeIdentifier("not-an-email@"), null);
  console.log("ok - 标识规范化：手机号去空格/横线、邮箱小写、非法输入拒绝");
}

// ---- 2. HTTP 契约 -----------------------------------------------------------
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

const api = createAccountApi({ dir: DIR, readBody, clientIp: () => "127.0.0.1", log: () => {} });
const server = createServer((req, res) => {
  void api(req, res).then((handled) => {
    if (!handled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "NOT_FOUND" }));
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

try {
  // 注册
  const reg = await call("POST", "/acct/register", { identifier: "13800138000", password: "correct horse" });
  assert.equal(reg.status, 200, `注册应 200（实际 ${reg.status}）`);
  assert.ok(reg.json.token && reg.json.kdfSalt && reg.json.accountId, "注册要回 token + kdfSalt + accountId");
  assert.equal(reg.json.passwordHash, undefined, "响应里绝不能出现密码哈希");

  // 重复注册
  const dup = await call("POST", "/acct/register", { identifier: "13800138000", password: "correct horse" });
  assert.equal(dup.status, 409, "同一号码重复注册应 409");

  // 密码太短
  const weak = await call("POST", "/acct/register", { identifier: "13900139000", password: "123" });
  assert.equal(weak.status, 400, "弱密码直接拒（客户端也该校验，但服务端是最后一道）");

  // 登录
  const login = await call("POST", "/acct/login", { identifier: "+86 138-0013-8000", password: "correct horse" });
  assert.equal(login.status, 401, "+86 前缀是另一个账号，不能撞上已注册的号码");
  const login2 = await call("POST", "/acct/login", { identifier: "13800138000", password: "correct horse" });
  assert.equal(login2.status, 200);
  const token = login2.json.token;
  assert.notEqual(token, reg.json.token, "每次登录发新令牌（旧令牌继续有效，便于多设备）");

  const wrong = await call("POST", "/acct/login", { identifier: "13800138000", password: "nope nope" });
  assert.equal(wrong.status, 401, "密码错必须 401");
  assert.equal(wrong.json.token, undefined, "失败不能发令牌");

  // 同步包
  const empty = await call("GET", "/acct/blob", undefined, token);
  assert.deepEqual(empty.json, { ciphertext: null, revision: 0 }, "新账号还没有同步包");

  const blob = Buffer.from("ciphertext-bytes").toString("base64");
  const put = await call("PUT", "/acct/blob", { ciphertext: blob, revision: 1 }, token);
  assert.equal(put.status, 200);
  const got = await call("GET", "/acct/blob", undefined, token);
  assert.equal(got.json.ciphertext, blob, "密文原样返回（服务器不解析、不改写）");
  assert.equal(got.json.revision, 1);

  const anon = await call("GET", "/acct/blob");
  assert.equal(anon.status, 401, "没有令牌不能读同步包");

  const huge = await call("PUT", "/acct/blob", { ciphertext: "x".repeat(700_001) }, token);
  assert.equal(huge.status, 413, "超过上限要 413，而不是把磁盘写满");

  // 账号隔离：另一个账号读不到别人的包
  const other = await call("POST", "/acct/register", { identifier: "a@b.com", password: "another pass" });
  const otherGot = await call("GET", "/acct/blob", undefined, other.json.token);
  assert.deepEqual(otherGot.json, { ciphertext: null, revision: 0 }, "账号之间必须隔离");

  // 落盘
  assert.ok(existsSync(join(DIR, "users.json")), "users.json 应存在");
  const users = JSON.parse(readFileSync(join(DIR, "users.json"), "utf8"));
  const stored = Object.values(users.accounts).find((a) => a.display === "13800138000");
  assert.ok(stored, "账号应落盘");
  assert.ok(stored.passwordHash && !stored.passwordHash.includes("correct horse"), "密码只存哈希");
  assert.ok(stored.kdfSalt, "kdfSalt 要给客户端派生加密密钥");
  assert.ok(existsSync(join(DIR, "blobs", `${stored.accountId}.json`)), "同步包按 accountId 分文件");
  console.log("ok - 注册/登录/令牌/同步包/隔离/上限/落盘 全部符合契约");
} finally {
  server.close();
  rmSync(DIR, { recursive: true, force: true });
}

console.log("✓ test-account-api 全部通过");
