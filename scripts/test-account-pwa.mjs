// 网页版（PWA）账号同步：**与 Node/桌面端实现互相解开同一个同步包**。
//
// 三端（安卓 Kotlin / 桌面 Node / 网页 WebCrypto）必须能解同一个密文，否则「手机登录后
// 桌面恢复身份」这类跨端场景会静默失败。这里用 Node 的 globalThis.crypto.subtle 直接
// 跑 PWA 的 lib，验证它是**字节级兼容**的（PBKDF2 参数、iv+tag 布局）。
import assert from "node:assert/strict";
import { register } from "node:module";

// PWA 的源码用无后缀相对 import（vite 要求），这里用同一套 loader 让 node 也能解析。
register(new URL("./electron-stub-loader.mjs", import.meta.url));

const node = await import("../src/main/account-sync.ts");
const pwa = await import("../mobile/pwa/src/lib/account-sync.ts");

const saltB64 = Buffer.alloc(16, 3).toString("base64");

// ---- 1. 同一密码 → 三端同一把钥匙 -------------------------------------------
{
  const nodeKey = node.deriveAccountKey("correct horse", saltB64);
  const pwaKey = await pwa.deriveAccountKey("correct horse", saltB64);
  assert.deepEqual(Buffer.from(pwaKey), nodeKey, "PWA 派生的密钥必须与桌面/安卓一致");
  console.log("ok - PBKDF2 参数与结果跨实现一致");
}

// ---- 2. 交叉解密（桌面加密 → 网页解密，反之亦然） ---------------------------
{
  const nodeKey = node.deriveAccountKey("correct horse", saltB64);
  const pwaKey = await pwa.deriveAccountKey("correct horse", saltB64);
  const plaintext = Buffer.from(JSON.stringify({ hello: "跨端", at: 1 }));

  const sealedByNode = node.sealAccountPayload(nodeKey, plaintext);
  const openedByPwa = await pwa.openPayload(pwaKey, sealedByNode);
  assert.ok(openedByPwa, "网页端必须能解开桌面端写的包（iv‖ct‖tag 布局一致）");
  assert.deepEqual(Buffer.from(openedByPwa), plaintext);

  const sealedByPwa = await pwa.sealPayload(pwaKey, new Uint8Array(plaintext));
  const openedByNode = node.openAccountPayload(nodeKey, sealedByPwa);
  assert.ok(openedByNode, "桌面端必须能解开网页端写的包");
  assert.deepEqual(openedByNode, plaintext);

  const wrongKey = node.deriveAccountKey("wrong horse", saltB64);
  assert.equal(node.openAccountPayload(wrongKey, sealedByPwa), null, "错的密码解不开");
  console.log("ok - 桌面↔网页交叉解密（错密码失败）");
}

// ---- 3. 墓碑与合并规则一致 ---------------------------------------------------
{
  const now = Date.now();
  const older = [{ hostId: "h1", at: now - 2_000 }, { hostId: "h2", at: now - 5_000 }];
  const newer = [{ hostId: "h1", at: now - 1_000 }, { hostId: "h3", at: now - pwa.TOMBSTONE_TTL_MS - 1 }];
  const nodeMerged = node.mergeTombstones(older, newer, now);
  const pwaMerged = pwa.mergeTombstones(older, newer, now);
  assert.deepEqual(pwaMerged, nodeMerged, "墓碑合并（取较新、丢过期）两端必须一致");
  assert.deepEqual(pwaMerged.map((stone) => stone.hostId), ["h1", "h2"]);

  const pairing = (hostId, pairedAt) => ({ hostId, relayUrl: "wss://x/ws", deviceId: "d", pairedAt });
  assert.equal(
    pwa.applyTombstones([pairing("h1", now - 100)], [{ hostId: "h1", at: now - 50 }]).length,
    0,
    "墓碑晚于配对 → 删除",
  );
  assert.equal(
    pwa.applyTombstones([pairing("h1", now - 10)], [{ hostId: "h1", at: now - 50 }]).length,
    1,
    "删了又重配（配对更晚）不能被旧墓碑删掉",
  );
  console.log("ok - 墓碑合并/生效判据与桌面端一致");
}

// ---- 4. 地址公网优先 ---------------------------------------------------------
{
  const candidates = ["wss://10.215.35.72:9443/ws", "wss://47.97.28.110:9443/ws", "ws://47.97.28.110:10445/ws"];
  assert.deepEqual(
    pwa.accountBasesOf(candidates),
    ["https://47.97.28.110:9443", "https://10.215.35.72:9443"],
    "网页端也要公网优先（换网络时内网地址必然不通）",
  );
  console.log("ok - 账号地址公网优先");
}

console.log("✓ test-account-pwa 全部通过");
