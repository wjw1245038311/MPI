// 桌面端账号同步（src/main/account-sync.ts）——加密 / 打包 / 合并 / 地址。
//
// 为什么这些要单独钉：桌面与手机**必须能互相解开同一个同步包**（同一账号在两台设备上
// 同步），所以密文布局（iv[12] ‖ ct ‖ tag[16]，base64）与 KDF 参数是协议。
// 另外「换电脑恢复主机身份」这条路径一旦把错的 identity 写回去，所有手机都会被踢下线，
// 合并规则必须显式且可测。
import assert from "node:assert/strict";

const mod = await import("../src/main/account-sync.ts");

// ---- 1. 密钥派生与密文布局 ---------------------------------------------------
{
  const salt = Buffer.alloc(16, 7).toString("base64");
  const other = Buffer.alloc(16, 9).toString("base64");
  const a = mod.deriveAccountKey("correct horse", salt);
  const b = mod.deriveAccountKey("correct horse", salt);
  const c = mod.deriveAccountKey("correct horse", other);
  assert.equal(a.length, 32, "AES-256 需要 32 字节密钥");
  assert.deepEqual(a, b, "同密码同盐必须得到同一把钥匙（跨设备/跨端）");
  assert.notDeepEqual(a, c, "盐不同→钥匙必须不同");

  const sealed = mod.sealAccountPayload(a, Buffer.from("hello-device-token"));
  const raw = Buffer.from(sealed, "base64");
  assert.ok(raw.length > 12 + 16, "密文至少是 iv + tag");
  assert.ok(!sealed.includes("device-token"), "密文里不能出现明文（base64 也不该出现）");
  assert.deepEqual(mod.openAccountPayload(a, sealed), Buffer.from("hello-device-token"));
  assert.equal(mod.openAccountPayload(c, sealed), null, "错的密码解不开");
  raw[raw.length - 1] ^= 0xff;
  assert.equal(
    mod.openAccountPayload(a, raw.toString("base64")),
    null,
    "篡改 tag 必须失败（GCM 完整性）",
  );
  assert.equal(mod.openAccountPayload(a, "not-base64"), null);
  console.log("ok - 密钥派生可复现、密文含 iv+tag、错密钥/篡改解不开");
}

// ---- 2. 同步包：白名单 + 本地优先合并 -----------------------------------------
{
  const identity = {
    hostId: "host-local",
    publicKeyPem: "pem",
    privateKeyPem: "priv",
    hmacSecret: "hmac",
    x25519PubB64u: "pub",
    x25519PrivB64u: "priv2",
    trustedDevices: [{ deviceId: "d1" }],
  };
  const local = mod.buildDesktopPayload({ identity, settings: { language: "zh", nsfw: "x" }, now: 10 });
  assert.deepEqual(Object.keys(local.settings), ["language"], "只同步白名单设置项");
  assert.equal(local.identity.trustedDevices.length, 1);

  const remote = {
    version: 1,
    updatedAt: 20,
    identity: { ...identity, hostId: "host-remote", trustedDevices: [] },
    settings: { language: "en", theme: "dark" },
  };
  const merged = mod.mergeDesktopPayload(local, remote);
  assert.equal(
    merged.identity.hostId,
    "host-local",
    "本机身份优先：本机有已配对设备时，绝不能被远端的覆盖（否则手机全掉线）",
  );
  assert.equal(merged.settings.language, "zh", "设置本地优先");
  assert.equal(merged.settings.theme, "dark", "远端独有的设置要补进来");

  // 新机器（本机没有身份）→ 采用远端身份（这正是「换电脑不重配」的场景）
  const fresh = mod.mergeDesktopPayload({ version: 1, updatedAt: 0, settings: {} }, remote);
  assert.equal(fresh.identity?.hostId, "host-remote");

  const decoded = mod.decodePayload(mod.encodePayload(merged));
  assert.deepEqual(decoded, merged, "编码/解码必须无损（含身份与设备清单）");
  assert.equal(mod.decodePayload(Buffer.from("not json")), null);
  console.log("ok - 同步包：白名单设置、本机身份优先、新机接受远端身份、编解码无损");
}

// ---- 3. 地址：公网优先 -------------------------------------------------------
{
  const candidates = [
    "wss://10.215.35.72:9443/ws",
    "ws://47.97.28.110:10445/ws",
    "wss://47.97.28.110:9443/ws",
  ];
  const bases = mod.accountBasesOf(candidates);
  assert.deepEqual(
    bases,
    ["https://47.97.28.110:9443", "https://10.215.35.72:9443"],
    "公网地址必须排前面（手机/本机可能不在主机同网段）",
  );
  assert.equal(mod.accountBasesOf(["ws://47.97.28.110:10445/ws"]).length, 0, "账号接口只走 TLS");
  assert.equal(mod.isPrivateHostUrl("https://192.168.68.2:9443"), true);
  assert.equal(mod.isPrivateHostUrl("https://172.20.1.9:9443"), true);
  assert.equal(mod.isPrivateHostUrl("https://relay.whomidas.cn:9443"), false);
  console.log("ok - 账号地址公网优先、只认 wss、内网判定覆盖 RFC1918");
}

console.log("✓ test-account-desktop 全部通过");
