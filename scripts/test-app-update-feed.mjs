/**
 * 桌面端自更新「中继镜像优先、GitHub 回退」的 feed 推导（纯逻辑，L1）。
 *
 * 覆盖 relayAppUpdateFeedUrl 的映射与拒绝规则，并交叉断言发布脚本推送的目录与
 * 客户端读取的路径**一致**（两侧漂移的表现是「客户端永远查不到新版本」，很难在
 * 应用里定位，所以用测试锁住）。
 *
 * 真正的 electron-updater 探测/回退流程（中继失败 → GitHub、镜像落后 → 也问 GitHub）
 * 跑不了 L1：app-updater.ts 依赖 electron 与 electron-updater，只能在实机验证。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_UPDATE_RELAY_PATH, relayAppUpdateFeedUrl } from "../src/shared/app-update-feed.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

// --- ws(s) → http(s) + 固定镜像路径 ---------------------------------------------
assert.equal(relayAppUpdateFeedUrl("wss://mpi-remote.example.com/ws"), "https://mpi-remote.example.com/download/app/");
assert.equal(relayAppUpdateFeedUrl("ws://192.168.1.20:9001/ws"), "http://192.168.1.20:9001/download/app/");
assert.equal(relayAppUpdateFeedUrl("https://relay.example.com/ws"), "https://relay.example.com/download/app/");
// 端口与查询/路径都丢掉，只留 origin
assert.equal(relayAppUpdateFeedUrl("wss://host:9443/ws?x=1"), "https://host:9443/download/app/");
assert.equal(relayAppUpdateFeedUrl("  wss://host/ws  "), "https://host/download/app/");

// --- 不可用的一律 null（→ 直接走 GitHub）----------------------------------------
assert.equal(relayAppUpdateFeedUrl(""), null);
assert.equal(relayAppUpdateFeedUrl("   "), null);
assert.equal(relayAppUpdateFeedUrl(undefined), null);
assert.equal(relayAppUpdateFeedUrl(null), null);
assert.equal(relayAppUpdateFeedUrl("不是地址"), null);
assert.equal(relayAppUpdateFeedUrl("ftp://host/ws"), null);
assert.equal(relayAppUpdateFeedUrl("file:///tmp/ws"), null);

// --- 路径常量与两端用法一致 -----------------------------------------------------
assert.equal(APP_UPDATE_RELAY_PATH, "/download/app/");
const publisher = read("scripts", "publish-release.mjs");
assert.match(publisher, /RELAY_APP_DIR = process\.env\.MPI_RELAY_APP_DIR \|\| '\S*\/download\/app'/, "publish-release.mjs 的中继目录尾段必须是 /download/app");
for (const name of ["latest.yml", "MPI-Setup-${version}.exe", "MPI-Setup-${version}.exe.blockmap"]) {
  assert.ok(publisher.includes(name), `publish-release.mjs 必须镜像 ${name}`);
}
// 客户端：中继优先、GitHub 回退、镜像落后时也问 GitHub
const updater = read("src", "main", "app-updater.ts");
assert.match(updater, /relayAppUpdateFeedUrl/);
assert.match(updater, /relayUpdateFeedUrl\(\) \? \["relay", "github"\] : \["github"\]/, "没有中继时不应该探测中继源");
assert.match(updater, /provider: "generic"/);
assert.match(updater, /provider: "github", owner: OWNER, repo: REPO/);
assert.match(updater, /staleRelay/, "镜像落后（版本比当前旧）时应继续问 GitHub");
// 中继静态服务必须支持 Range —— electron-updater 的差量下载（.blockmap）依赖它
const relay = read("mobile", "relay", "index.mjs");
assert.match(relay, /accept-ranges/, "中继静态服务必须声明 accept-ranges");
assert.match(relay, /content-range/, "中继静态服务必须回 Content-Range");

console.log("app-update-feed: 全部检查通过");
