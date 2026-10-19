/**
 * 主机身份绑定（pinning）—— 中继不可信模型下的第二道防线。
 *
 * 背景（2026-10-19 审计，docs/SECURITY-AUDIT-2026-10-19-RELAY-MITM.md §2）：
 * 配对证明 v2 只把 **X25519 公钥**绑进签名，没把**身份公钥**绑到 `hostId`。
 * 于是中继可以递自己的 Ed25519 公钥并自签，手机验签照样通过 → 全程 MITM。
 *
 * 这里钉住三件事：
 *  1. 公钥必须能哈希回票里的 hostId（hostId 来自扫码，中继改不了）；
 *  2. 已 pin 的记录，公钥一变就拒（长期 MITM 无法在重连时静默接管）；
 *  3. 旧记录（无 pin）/旧票（无 hostPublicKeyPem）仍能配对——兼容性不能被安全修死。
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

const { hostIdFor, createDeviceIdentity } = await import("../mobile/pwa/src/lib/device-identity.ts");
const { checkHostIdentity } = await import("../mobile/pwa/src/lib/pairing.ts");

/** 造一对 Ed25519 身份，返回 PEM 与它对应的 hostId（与桌面 hostIdFor 同算法）。 */
function makeHost() {
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const hostId = createHash("sha256").update(pem).digest("base64url").slice(0, 24);
  return { pem, hostId };
}

const victim = makeHost();
const attacker = makeHost();

// 0) hostIdFor 必须与桌面 hostIdFor 逐字节一致（sha256(PEM) base64url[:24]，无前缀）
assert.equal(hostIdFor(victim.pem), victim.hostId, "hostIdFor 与桌面算法不一致");
assert.match(victim.hostId, /^[A-Za-z0-9_-]{24}$/);
console.log("[0] hostIdFor 与桌面一致：", victim.hostId);

// 1) 正常配对：公钥哈希等于票里的 hostId → 放行
checkHostIdentity({ hostId: victim.hostId, hostPublicKeyPem: victim.pem });
console.log("[1] 正确主机放行");

// 2) 中继冒充：hostId 照抄受害主机，但公钥是自己的 → 必须拒
assert.throws(
  () => checkHostIdentity({ hostId: victim.hostId, hostPublicKeyPem: attacker.pem }),
  /hostId 不符/,
  "中继换身份公钥时必须拒绝",
);
console.log("[2] 中继换身份公钥被拒");

// 3) pinning：已配对记录里的公钥变了 → 必须拒（即便攻击者能让哈希对上也不可能，这里是双保险）
assert.throws(
  () => checkHostIdentity({ hostId: attacker.hostId, hostPublicKeyPem: attacker.pem, pinnedHostPublicKeyPem: victim.pem }),
  /已变化/,
  "已 pin 的主机公钥变化必须拒绝",
);
console.log("[3] 已 pin 后换公钥被拒");

// 4) 票里自带身份公钥且与 challenge 不符 → 直接拒（有值就按值比对，比哈希更强）
assert.throws(
  () => checkHostIdentity({ hostId: victim.hostId, hostPublicKeyPem: victim.pem, ticketHostPublicKeyPem: attacker.pem }),
  /与配对票不符/,
);
console.log("[4] 票内公钥与对端不符被拒");

// 5) 兼容：旧票（只有 hostId）+ 旧记录（无 pin）→ 仍可配对，且调用方随后回填 pin
checkHostIdentity({ hostId: victim.hostId, hostPublicKeyPem: victim.pem, pinnedHostPublicKeyPem: undefined });
console.log("[5] 旧票/旧记录兼容（无 pin 时只做哈希校验）");

// 6) 缺公钥 / 空 PEM → 拒（不允许「验不了就放行」）
assert.throws(() => checkHostIdentity({ hostId: victim.hostId, hostPublicKeyPem: "" }), /缺少主机身份公钥/);
console.log("[6] 空公钥被拒");

// 7) 手机侧身份不受影响（回归：设备 deviceId 规则没被 hostIdFor 改动带偏）
const device = createDeviceIdentity();
assert.match(device.deviceId, /^device-[A-Za-z0-9_-]{24}$/);
console.log("[7] 设备身份派生不变：", device.deviceId.slice(0, 16) + "…");

console.log("\n主机身份绑定：7 项全部通过");
