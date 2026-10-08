/**
 * 「同一台设备」的识别规则 + PWA 设备名（纯逻辑，L1）。
 *
 * 覆盖 src/shared/remote-device-match.ts 与 mobile/pwa/src/lib/device-name.ts，
 * 并交叉断言主机/网页端/面板三处接线（防止逻辑写了但没人用、或开关没接上 config）。
 * 真实的配对链路（approvePairing 建/换记录）由发版后的真机验证，见 changelog 验证方式。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findTrustedDevice,
  pickSameNameOfflineReplacement,
  shortDeviceId,
} from "../src/shared/remote-device-match.ts";
import {
  LEGACY_DEVICE_NAME,
  defaultDeviceName,
  platformLabel,
  shortDeviceLabel,
} from "../mobile/pwa/src/lib/device-name.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

const device = (over = {}) => ({
  deviceId: "device-aaaaaaaaaaaa",
  name: "MPI PWA · Android/Chrome · aaaa",
  publicKeyPem: "PEM-A",
  addedAt: 1_000,
  ...over,
});

// --- ① deviceId 命中 → ② 公钥命中 -------------------------------------------------
const byId = device({ deviceId: "device-1", publicKeyPem: "PEM-1" });
const byKeyOnly = device({ deviceId: "device-2", publicKeyPem: "PEM-2" });
const list = [byId, byKeyOnly];
assert.equal(findTrustedDevice(list, "device-1", "PEM-other"), byId, "deviceId 优先命中");
assert.equal(findTrustedDevice(list, "device-new", "PEM-2"), byKeyOnly, "deviceId 不中时按公钥兜底");
assert.equal(findTrustedDevice(list, "device-new", "PEM-new"), undefined, "全新设备不命中");
assert.equal(findTrustedDevice([], "device-1", "PEM-1"), undefined);

// --- 同名 + 离线：只换最久没露面的那条 --------------------------------------------
const online = (ids) => (deviceId) => ids.includes(deviceId);
const older = device({ deviceId: "device-old", name: "MPI PWA · Android/Chrome · aaaa", lastSeenAt: 5_000 });
const newer = device({ deviceId: "device-new", name: "MPI PWA · Android/Chrome · aaaa", lastSeenAt: 9_000 });
const other = device({ deviceId: "device-x", name: "别的名字", lastSeenAt: 100 });

assert.equal(
  pickSameNameOfflineReplacement([older, newer, other], older.name, online([]))?.deviceId,
  "device-old",
  "同名有多条时取最久没露面的",
);
assert.equal(
  pickSameNameOfflineReplacement([older, newer], older.name, online(["device-old"]))?.deviceId,
  "device-new",
  "正在连接的那条不能被替换（否则把在用的设备踢掉）",
);
assert.equal(pickSameNameOfflineReplacement([older, newer], older.name, online(["device-old", "device-new"])), null);
assert.equal(pickSameNameOfflineReplacement([older], "别的名字", online([])), null, "名字不同不替换");
assert.equal(pickSameNameOfflineReplacement([older], "", online([])), null, "空名字不参与匹配");
assert.equal(pickSameNameOfflineReplacement([older], "   ", online([])), null);
// addedAt 兜底：没有 lastSeenAt 时用 addedAt 比新旧
const noSeenOld = device({ deviceId: "device-a", name: "N", addedAt: 10 });
const noSeenNew = device({ deviceId: "device-b", name: "N", addedAt: 20 });
assert.equal(pickSameNameOfflineReplacement([noSeenOld, noSeenNew], "N", online([]))?.deviceId, "device-a");

// --- 短号 -------------------------------------------------------------------------
assert.equal(shortDeviceId("device-85pUtRIs_SZz0"), "85pUt");
assert.equal(shortDeviceId("device-85pUtRIs_SZz0", 4), "85pU");
assert.equal(shortDeviceId(""), "?");
assert.equal(shortDeviceLabel("device-85pUtRIs_SZz0"), "85pU");
assert.equal(shortDeviceLabel(""), "????");

// --- PWA 设备名 -------------------------------------------------------------------
const androidChrome = "Mozilla/5.0 (Linux; Android 14; HONOR PGT-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const iphoneSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const winEdge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
assert.equal(platformLabel(androidChrome), "Android/Chrome");
assert.equal(platformLabel(iphoneSafari), "iOS/Safari");
assert.equal(platformLabel(winEdge), "Windows/Edge");
assert.equal(platformLabel("curl/8.0"), "Browser", "识别不出时给 Browser 而不是空串");
assert.equal(platformLabel(""), "Browser");

assert.equal(defaultDeviceName(androidChrome, "device-85pUtRIs_SZz0"), "MPI PWA · Android/Chrome · 85pU");
assert.equal(defaultDeviceName(winEdge, ""), "MPI PWA · Windows/Edge · ????");
// 同一部手机、不同 origin → 短号不同（这正是主机侧「同名但可分辨」的依据）
const a = defaultDeviceName(androidChrome, "device-AAAABBBB");
const b = defaultDeviceName(androidChrome, "device-CCCCDDDD");
assert.notEqual(a.split("· ").at(-1), b.split("· ").at(-1));
assert.equal(LEGACY_DEVICE_NAME, "MPI PWA");

// --- 接线：主机 / PWA / 面板 / config --------------------------------------------
const host = read("src", "main", "remote", "host.ts");
assert.match(host, /findTrustedDevice\(/, "approvePairing 必须按 deviceId→公钥 匹配（不再只认 deviceId）");
assert.match(host, /pickSameNameOfflineReplacement\(/, "approvePairing 必须做「同名离线替换」");
assert.match(host, /replaceSameNameOfflineDevice\?\.\(\) !== false/, "必须支持在设置里关掉同名替换");
assert.match(host, /notifyRevoked\?\.\(replaced\.deviceId\)/, "被替换的旧绑定要顺手撤掉中继 token");
assert.match(host, /remote-rename device=/, "重连时要刷新设备名（改过名的设备不必重新配对才能看到）");
assert.match(host, /remote-device-match/, "逻辑必须来自共享模块（而不是 host.ts 里另写一份）");

const pwa = read("mobile", "pwa", "src", "App.tsx");
assert.match(pwa, /defaultDeviceName\(navigator\.userAgent/, "PWA 必须用带短号的可辨识设备名");
assert.match(pwa, /LEGACY_DEVICE_NAME/, "老安装的写死名字要迁移");
assert.doesNotMatch(pwa, /name: "MPI PWA"/, "不应再有写死的设备名");

const panel = read("src", "renderer", "src", "components", "RemotePanel.tsx");
assert.match(panel, /shortDeviceId\(device\.deviceId\)/, "面板已信任设备列表要显示短号");
assert.match(panel, /remoteReplaceSameNameOffline/, "面板开关必须写回 config");

const config = read("src", "main", "config.ts");
assert.match(config, /remoteReplaceSameNameOffline: true/, "默认开启同名离线替换");
const ipc = read("src", "main", "ipc.ts");
assert.match(ipc, /replaceSameNameOfflineDevice: \(\) => getConfig\(\)\.remoteReplaceSameNameOffline/, "开关必须接到 RemoteHost");

console.log("remote-device-dedup: 全部检查通过");
