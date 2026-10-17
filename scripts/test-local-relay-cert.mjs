/**
 * 本机中继证书（`src/main/local-relay-cert.ts`）：复用判定 + 自动生成/重签。
 *
 * 为什么值得有 L1：这段逻辑的价值全在「什么时候重签」——
 *   · 地址没变、证书还没过期 → **必须复用**（重签会让已装根证书的设备继续可信，但换叶子没必要）；
 *   · 内网 IP 变了 / 证书过期 → **必须重签**（否则浏览器提示 NET::ERR_CERT_COMMON_NAME_INVALID）。
 * 走真实生成（RSA 2048 × 2，约 200ms），因为签名参数错了只有真正解析才看得出来。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ensureLocalRelayCert, certCovers, certIpAddresses } = await import("../src/main/local-relay-cert.ts");

const dir = mkdtempSync(join(tmpdir(), "mpi-cert-test-"));
try {
  const addresses = ["10.0.0.5", "100.90.55.36"];

  // ---- ① 首次：生成 CA + 叶子 ------------------------------------------------
  const first = await ensureLocalRelayCert({ dir, addresses, hostname: "workstation" });
  assert.ok(first, "应当生成成功");
  assert.equal(first.generated, true);
  assert.ok(existsSync(first.certFile) && existsSync(first.keyFile), "证书与私钥都要落盘");
  assert.ok(existsSync(first.caFile), "CA 证书也要落盘（给设备装根证书）");
  const leafPem = readFileSync(first.certFile, "utf8");
  const covered = certIpAddresses(leafPem);
  for (const ip of addresses) assert.ok(covered.includes(ip), `SAN 应包含 ${ip}（实际 ${covered.join(",")}）`);
  assert.match(String(first.reason), /重签完成/);

  // ---- ② 再跑一次：必须复用（不重签） ----------------------------------------
  const second = await ensureLocalRelayCert({ dir, addresses, hostname: "workstation" });
  assert.equal(second.generated, false, "地址没变且证书有效 → 复用");
  assert.match(String(second.reason), /复用/);
  assert.equal(readFileSync(second.certFile, "utf8"), leafPem, "复用则证书内容一字不动");

  // ---- ③ 地址变了：必须重签 ------------------------------------------------
  const third = await ensureLocalRelayCert({ dir, addresses: [...addresses, "192.168.9.9"], hostname: "workstation" });
  assert.equal(third.generated, true, "SAN 缺新地址 → 重签");
  assert.ok(certIpAddresses(readFileSync(third.certFile, "utf8")).includes("192.168.9.9"));
  assert.equal(third.caFile, first.caFile, "CA 不变（设备上已装的根证书继续有效）");

  // ---- ④ 配置里指向坏文件：退回自动生成 --------------------------------------
  const badCert = join(dir, "bad.crt");
  const badKey = join(dir, "bad.key");
  writeFileSync(badCert, "-----BEGIN CERTIFICATE-----\nnot a cert\n-----END CERTIFICATE-----\n");
  writeFileSync(badKey, "-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----\n");
  const repaired = await ensureLocalRelayCert({ dir, certFile: badCert, keyFile: badKey, addresses, hostname: "workstation" });
  assert.equal(repaired.generated, false, "坏配置被忽略，回落到已生成好的目录内证书");
  assert.equal(repaired.certFile, join(dir, "lan-relay.crt"));

  // ---- ⑤ 没有地址：不生成 ---------------------------------------------------
  assert.equal(await ensureLocalRelayCert({ dir: join(dir, "empty"), addresses: [] }), null);

  // ---- ⑥ certCovers 的过期判定 ---------------------------------------------
  assert.equal(certCovers(leafPem, addresses).ok, true);
  assert.equal(certCovers(leafPem, ["203.0.113.7"]).ok, false, "缺地址 → 不可用");
  assert.match(certCovers(leafPem, ["203.0.113.7"]).reason, /SAN/);
  assert.equal(certCovers("garbage", addresses).ok, false, "坏证书 → 不可用");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("local-relay-cert: 全部检查通过");
