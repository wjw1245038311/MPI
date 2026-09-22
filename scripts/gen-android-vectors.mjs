/**
 * 从 PWA 的 TS 参考实现生成 Android 侧 Kotlin 测试所用的固定向量。
 *
 * 用途：docs/MOBILE-NATIVE-DESIGN.md M0-5 —— 证明 Kotlin 加密实现与 TS/Node 字节级一致。
 * 跑法：node --experimental-transform-types scripts/gen-android-vectors.mjs
 * 输出与 mobile/app 的 E2eCryptoVectorTest.kt 中钉死的常量一一对应（勿手改常量）。
 * 改协议（HKDF info / 密钥布局 / 帧格式 / 身份导出）后必须重跑，并同步两侧常量
 * 与 scripts/test-e2e-crypto.mjs 的 PINNED_* 值。
 */
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { createDeviceIdentity, toBase64Url } = await import("../mobile/pwa/src/lib/device-identity.ts");
const { deriveAesKeyRaw, encryptFrame, importAesKey, x25519SharedSecretRaw, e2eInfoString } =
  await import("../mobile/pwa/src/lib/e2e-crypto.ts");

// ---- 设备身份（固定种子 0x5a × 32）----
const seed = new Uint8Array(32).fill(0x5a);
const id = createDeviceIdentity(toBase64Url(seed));

console.log("== 设备身份（固定种子）==");
console.log("seedB64u        =", toBase64Url(seed));
console.log("deviceId        =", id.deviceId);
console.log("x25519PubB64u   =", id.x25519PubB64u);
console.log("x25519PrivB64u  =", id.x25519PrivB64u);
console.log("sig|hello-mpi   =", id.signText("hello-mpi"));
console.log("pem             =", JSON.stringify(id.publicKeyPem));

// ---- E2E 固定输入（与 scripts/test-e2e-crypto.mjs 同一组）----
const privA = toBase64Url(new Uint8Array(32).fill(0x77));
const privB = toBase64Url(new Uint8Array(32).fill(0x42));
const base = toBase64Url(new Uint8Array([9, ...new Uint8Array(31)]));
const pubA = toBase64Url(x25519SharedSecretRaw(privA, base));
const pubB = toBase64Url(x25519SharedSecretRaw(privB, base));

console.log("\n== X25519 ==");
console.log("privA           =", privA);
console.log("privB           =", privB);
console.log("pubA            =", pubA);
console.log("pubB            =", pubB);

const HOST_ID = "host-test-vector";
const DEVICE_ID = "device-test-vector";
const shared = x25519SharedSecretRaw(privA, pubB);
const keyRaw = deriveAesKeyRaw(shared, HOST_ID, DEVICE_ID);

console.log("\n== HKDF ==");
console.log("info            =", e2eInfoString(HOST_ID, DEVICE_ID));
console.log("sharedHex       =", Buffer.from(shared).toString("hex"));
console.log("aesKeyHex       =", Buffer.from(keyRaw).toString("hex"));

// ---- AES-GCM：固定 nonce 下结果确定，Kotlin 侧应能复现同一密文 ----
const key = await importAesKey(keyRaw);
const plain = JSON.stringify({ v: 1, type: "projects.list", reqId: "req-v1", sessionId: "sess-v1" });
const frame = await encryptFrame(key, plain);

console.log("\n== AES-GCM ==");
console.log("plainJson       =", plain);
console.log("nonce           =", frame.n);
console.log("cipher          =", frame.c);
