/**
 * 配对证明 v2（把 E2E 公钥绑进签名）—— 中继不可信模型下的关键防线。
 *
 * 背景（docs/RELAY-SHARING.md §9）：v1 签的文本不含 X25519 公钥，而两端的公钥都走**明文**帧
 * （主机公钥在 pair.accepted 里注入、设备公钥在 pair.hello 里），于是一个恶意中继可以把自己的
 * 公钥分别塞给两端 → 各自与中继派生会话密钥 → **它能解开全部「加密」流量**。
 *
 * 这里钉住的就是「换公钥必失败」：只要证明验不过，主机/设备都必须拒绝，而不是退回 v1。
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { register } from "node:module";
register(new URL("./electron-stub-loader.mjs", import.meta.url));
const { loadOrCreateIdentity, signText, x25519KeyPair } = await import("../src/main/remote/identity.ts");
const { allowUnboundE2E, deviceProofText, hostProofText, legacyDeviceProofText, legacyHostProofText, verifyDeviceProof, verifyHostProof } =
  await import("../src/main/remote/pairing-proof.ts");

const dir = mkdtempSync(join(tmpdir(), "mpi-proof-"));
try {
  const identity = loadOrCreateIdentity(dir);
  const hostPub = identity.publicKeyPem;
  const sign = (text) => signText(identity.privateKeyPem, text);
  const base = { hostId: identity.hostId, connectionId: "conn-1", challenge: "chal-1" };
  const hostX25519 = identity.x25519PubB64u;
  const relayX25519 = x25519KeyPair().pubB64u; // 中继想替换成的公钥
  const device = x25519KeyPair();

  // ---- 1. 主机证明：正常通过；**换公钥必失败** ----
  {
    const signature = sign(hostProofText({ ...base, hostX25519Pub: hostX25519 }));
    assert.deepEqual(
      verifyHostProof({ publicKeyPem: hostPub, signature, proof: base, declaredX25519Pub: hostX25519 }),
      { mode: "bound" },
      "主机按 v2 签 → 设备应验过",
    );
    assert.equal(
      verifyHostProof({ publicKeyPem: hostPub, signature, proof: base, declaredX25519Pub: relayX25519 }),
      null,
      "★ 中继把主机公钥换成自己的 → 签名对不上，必须拒绝（这就是 MITM 防线）",
    );
    assert.equal(
      verifyHostProof({ publicKeyPem: hostPub, signature, proof: { ...base, challenge: "chal-2" }, declaredX25519Pub: hostX25519 }),
      null,
      "挑战值被改也不行",
    );
  }

  // ---- 2. 设备证明：正常通过；**换公钥必失败** ----
  {
    const proofInput = { ...base, deviceId: "device-test", deviceX25519Pub: device.pubB64u };
    const signature = sign(deviceProofText(proofInput));
    assert.deepEqual(
      verifyDeviceProof({ publicKeyPem: hostPub, signature, proof: proofInput }),
      { ok: true, mode: "bound" },
      "设备按 v2 签 → 主机应验过",
    );
    assert.deepEqual(
      verifyDeviceProof({ publicKeyPem: hostPub, signature, proof: { ...proofInput, deviceX25519Pub: relayX25519 } }),
      { ok: false, mode: "legacy", reason: "signature-invalid" },
      "★ 中继换设备公钥 → 签名对不上，必须拒",
    );
  }

  // ---- 3. 带公钥却只签 v1（旧客户端）→ 默认拒收，避免中继降级 ----
  {
    const legacySig = sign(legacyDeviceProofText({ ...base, deviceId: "device-old" }));
    const verdict = verifyDeviceProof({
      publicKeyPem: hostPub,
      signature: legacySig,
      proof: { ...base, deviceId: "device-old", deviceX25519Pub: device.pubB64u },
    });
    assert.equal(verdict.ok, false, "带 E2E 公钥却只签 v1 的客户端默认拒收（否则中继塞个公钥就降级成功）");
    assert.equal(verdict.reason, "e2e-key-not-signed");

    // 救急开关（MPI_ALLOW_UNBOUND_E2E=1）才放行，且要标记为 legacy
    process.env.MPI_ALLOW_UNBOUND_E2E = "1";
    assert.equal(allowUnboundE2E(), true, "救急开关能被读到");
    process.env.MPI_ALLOW_UNBOUND_E2E = "";
    assert.equal(allowUnboundE2E(), false, "默认关闭");
  }

  // ---- 4. 没带公钥（真旧客户端）：默认也拒（不让中继把「无 E2E」当降级跳板）----
  {
    const legacySig = sign(legacyDeviceProofText({ ...base, deviceId: "device-plain" }));
    const verdict = verifyDeviceProof({
      publicKeyPem: hostPub,
      signature: legacySig,
      proof: { ...base, deviceId: "device-plain", deviceX25519Pub: "" },
    });
    assert.equal(verdict.ok, false, "无 E2E 的旧客户端默认拒（要开 MPI_ALLOW_UNBOUND_E2E）");
    assert.equal(verdict.reason, "legacy-client-rejected");
    // 旧主机证明同理：只有救急开关才认
    assert.equal(
      verifyHostProof({
        publicKeyPem: hostPub,
        signature: sign(legacyHostProofText(base)),
        proof: base,
        declaredX25519Pub: hostX25519,
      }),
      null,
      "旧主机（v1）证明默认不认",
    );
  }

  // ---- 5. 身份不匹配（别人的签名）也不能过 ----
  {
    const other = generateKeyPairSync("ed25519");
    const otherPem = other.publicKey.export({ type: "spki", format: "pem" }).toString();
    const signature = sign(deviceProofText({ ...base, deviceId: "device-x", deviceX25519Pub: device.pubB64u }));
    const verdict = verifyDeviceProof({
      publicKeyPem: otherPem,
      signature,
      proof: { ...base, deviceId: "device-x", deviceX25519Pub: device.pubB64u },
    });
    assert.equal(verdict.ok, false, "换一把公钥验签必然失败");
  }

  console.log("ok 1 - 主机证明 v2：正常通过 / 换公钥必失败（MITM 防线）");
  console.log("ok 2 - 设备证明 v2：正常通过 / 换公钥必失败");
  console.log("ok 3 - 带公钥只签 v1 → 默认拒收（需 MPI_ALLOW_UNBOUND_E2E=1 救急）");
  console.log("ok 4 - 无 E2E 的旧客户端与旧主机证明默认都不认");
  console.log("ok 5 - 身份不匹配（他人签名）验不过");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("pairing-proof tests passed");
