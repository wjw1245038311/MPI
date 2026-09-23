import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const schema = JSON.parse(readFileSync(resolve(root, "protocol", "remote-v1.schema.json"), "utf8"));

assert.equal(schema.$id, "https://mpi.dev/protocol/remote-v1.schema.json");
assert.equal(schema.properties.v.const, 1);
assert.deepEqual(schema.required, ["v", "type", "sessionId", "sentAt"]);
assert.ok(schema.properties.type.maxLength <= 80);
assert.ok(schema["x-request-types"].includes("thread.setModel"));
assert.match(JSON.stringify(schema.$defs.remoteSkill), /skill:/);

const protocol = readFileSync(resolve(root, "src", "main", "remote", "protocol.ts"), "utf8");
assert.match(protocol, /"thread\.setModel"/);
// 会话元数据操作（手机端长按菜单）：协议 + 主机实现都要在
assert.match(protocol, /"thread\.rename"/);
assert.match(protocol, /"thread\.setPinned"/);
assert.match(protocol, /"thread\.delete"/);
assert.match(schema["x-request-types"].join("\n"), /thread\.setPinned/);
assert.match(protocol, /interface RemoteModelOption/);
assert.match(protocol, /interface RemoteSkill/);
assert.match(protocol, /interface RemoteFileArtifact/);

const desktopIpc = readFileSync(resolve(root, "src", "main", "ipc.ts"), "utf8");
assert.match(desktopIpc, /availableModels: remoteModelOptions/);
assert.match(desktopIpc, /skills: remoteSkills/);
assert.match(desktopIpc, /MODEL_UNAVAILABLE/);
assert.match(desktopIpc, /lastReplyIndex/);
// 会话元数据操作（手机端长按菜单）：主机端与删除实现共用一份
assert.match(desktopIpc, /deleteSessionThreadByFile/);
assert.match(desktopIpc, /renameThread: async/);
assert.match(desktopIpc, /setThreadPinned: async/);
assert.match(desktopIpc, /remotePathFromArgs\(block\.arguments\)/);
assert.match(desktopIpc, /readRemotePreview\(target\)/);
assert.match(desktopIpc, /\["text", "markdown", "html", "image", "xlsx"\]/);

const previewService = readFileSync(resolve(root, "src", "main", "preview-service.ts"), "utf8");
assert.match(previewService, /export function readRemotePreview/);
assert.match(previewService, /mpi-xlsx-v1/);
assert.match(previewService, /REMOTE_SHEET_MAX_JSON_CHARS/);

const androidProtocol = readFileSync(resolve(root, "android", "app", "src", "main", "java", "com", "mpi", "remote", "RemoteProtocol.kt"), "utf8");
assert.match(androidProtocol, /data class RemoteModelOption/);
assert.match(androidProtocol, /data class RemoteSkill/);
assert.match(androidProtocol, /data class RemoteFileArtifact/);

const androidMain = readFileSync(resolve(root, "android", "app", "src", "main", "java", "com", "mpi", "remote", "MainActivity.kt"), "utf8");
assert.match(androidMain, /isAllowedHtmlPreviewUri/);
assert.match(androidMain, /requestDisallowInterceptTouchEvent/);
assert.match(androidMain, /return !isAllowedHtmlPreviewUri/);
// The shell is a WebView on the relay's PWA: it must carry a default relay URL
// and keep its dev-only escapes (WebView debugging, loopback TLS override) behind
// BuildConfig.DEBUG so a release build cannot proceed past a bad certificate.
assert.match(androidMain, /DEFAULT_BASE_URL/);
assert.match(androidMain, /BuildConfig\.DEBUG/);
assert.match(androidMain, /onReceivedSslError/);

const androidManifest = readFileSync(resolve(root, "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
assert.match(androidManifest, /android\.permission\.INTERNET/);
assert.match(androidManifest, /android:name="\.MainActivity"/);
// 壳内扫码与自更新需要的声明（少一个就是功能坏了，不是可选优化）
assert.match(androidManifest, /android\.permission\.CAMERA/);
assert.match(androidManifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
assert.match(androidManifest, /android:name="\.ScanActivity"/);
assert.match(androidManifest, /androidx\.core\.content\.FileProvider/);

const androidScan = readFileSync(resolve(root, "android", "app", "src", "main", "java", "com", "mpi", "remote", "ScanActivity.kt"), "utf8");
assert.match(androidScan, /BarcodeScanning\.getClient/);
assert.match(androidScan, /FORMAT_QR_CODE/);
assert.match(androidScan, /ProcessCameraProvider/);

const androidUpdater = readFileSync(resolve(root, "android", "app", "src", "main", "java", "com", "mpi", "remote", "Updater.kt"), "utf8");
assert.match(androidUpdater, /download\/mpi-android\.json/);
assert.match(androidUpdater, /SHA-256/);
assert.match(androidUpdater, /compareVersions/);
assert.match(androidUpdater, /FileProvider\.getUriForFile/);
assert.match(androidUpdater, /application\/vnd\.android\.package-archive/);

// PWA 靠 window.MpiShell 探测「在壳里」——壳里必须真注入这个桥，否则扫码按钮永不出现。
assert.match(androidMain, /addJavascriptInterface/);
assert.match(androidMain, /"MpiShell"/);
assert.match(androidMain, /scanPairQr/);
const pwaApp = readFileSync(resolve(root, "mobile", "pwa", "src", "App.tsx"), "utf8");
assert.match(pwaApp, /MpiShell/);
assert.match(pwaApp, /scanPairQr/);
// 扫码结果要交给 PWA 的 #pair= 自动配对路径，不要在原生侧重写配对逻辑。
assert.match(androidMain, /#pair=/);

const source = readFileSync(resolve(root, "src", "main", "remote", "host.ts"), "utf8");
assert.match(source, /directOnly:\s*true/);
assert.match(source, /relay-candidate-rejected/);
assert.doesNotMatch(source, /turns?:/i);

const config = readFileSync(resolve(root, "src", "main", "config.ts"), "utf8");
assert.match(config, /wss:\/\/mpi-remote\.scholarcn\.com\/ws/);
for (const stunUrl of [
  "stun:stun.miwifi.com:3478",
  "stun:stun.chat.bilibili.com:3478",
  "stun:stun.cloudflare.com:3478",
]) {
  assert.match(config, new RegExp(stunUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

const remotePanel = readFileSync(resolve(root, "src", "renderer", "src", "components", "RemotePanel.tsx"), "utf8");
assert.match(remotePanel, /Signal connection/);
assert.doesNotMatch(remotePanel, />Host ID<|>Transport<|>Last error<|STUN URLs|stunText/);

const transport = readFileSync(resolve(root, "src", "renderer", "src", "remote", "transport.ts"), "utf8");
assert.match(transport, /typ\\s\+relay/);
assert.match(transport, /iceServers/);
assert.match(transport, /transportStatus/);
assert.match(transport, /pi-remote-heartbeat-v1:ping/);
assert.match(transport, /heartbeat-timeout/);

// The Android companion used to be a native WebRTC client (its own signalling,
// STUN handling and heartbeat — see the git history of this file). That transport
// was retired in favour of the WSS relay (docs/MOBILE-DESIGN.md §6.3), so the
// shell now loads the shared H5 bundle and owns no transport code at all. The
// assertions above cover what the shell actually does; there is deliberately no
// WebRtcClient.kt requirement any more.

console.log("remote protocol checks passed");
