/**
 * 桌面端自更新的**源解析**（纯逻辑，L1）。
 *
 * 覆盖三块最容易悄悄错的：
 *   ① `relayAppUpdateFeedUrl` 的 ws(s)→http(s) 映射与拒绝规则；
 *   ② `resolveAppUpdateFeed` 的源选择（env 覆盖 > 配置选 ecs > GitHub），
 *      重点是「**没授权就不该去探测 ECS**」——否则别人的安装会去敲这台私有 ECS；
 *   ③ 旧行为迁移（`legacyAppUpdateSource`，通道地址 → 镜像 feed）不走样，
 *      以及发布脚本推送目录 / 中继门控与客户端读取路径一致（漂移的表现是
 *      「客户端永远查不到新版本」，很难在应用里定位，所以用测试锁住）。
 *
 * 真正的 electron-updater 探测/回退流程（5s 预探测 → GitHub）跑不了 L1：
 * app-updater.ts 依赖 electron 与 electron-updater，只能在实机验证；
 * 这里对它做源码级断言（防回退到「先等 60s 才回退」的老行为）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_UPDATE_ECS_PROBE_TIMEOUT_MS,
  APP_UPDATE_RELAY_PATH,
  DEFAULT_APP_UPDATE_RELAY_URL,
  legacyAppUpdateSource,
  relayAppUpdateFeedUrl,
  resolveAppUpdateFeed,
} from "../src/shared/app-update-feed.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

// --- ws(s) → http(s) + 固定镜像路径 ---------------------------------------------
assert.equal(relayAppUpdateFeedUrl("wss://mpi-remote.example.com/ws"), "https://mpi-remote.example.com/download/app/");
assert.equal(relayAppUpdateFeedUrl("ws://192.168.1.20:9001/ws"), "http://192.168.1.20:9001/download/app/");
assert.equal(relayAppUpdateFeedUrl("https://relay.example.com/ws"), "https://relay.example.com/download/app/");
// 端口与查询/路径都丢掉，只留 origin
assert.equal(relayAppUpdateFeedUrl("wss://host:9443/ws?x=1"), "https://host:9443/download/app/");
assert.equal(relayAppUpdateFeedUrl("  wss://host/ws  "), "https://host/download/app/");

// --- 不可用的一律 null（→ 保持 GitHub）------------------------------------------
assert.equal(relayAppUpdateFeedUrl(""), null);
assert.equal(relayAppUpdateFeedUrl("   "), null);
assert.equal(relayAppUpdateFeedUrl(undefined), null);
assert.equal(relayAppUpdateFeedUrl(null), null);
assert.equal(relayAppUpdateFeedUrl("不是地址"), null);
assert.equal(relayAppUpdateFeedUrl("ftp://host/ws"), null);
assert.equal(relayAppUpdateFeedUrl("file:///tmp/ws"), null);

// --- 源解析：默认 GitHub，授权后才走 ECS ----------------------------------------
const GITHUB = { source: "github", url: null, token: "" };
assert.deepEqual(resolveAppUpdateFeed({}), GITHUB, "什么都没配 → 只用 GitHub");
assert.deepEqual(resolveAppUpdateFeed({ source: "github", relayUrl: "http://ecs.example/download/app/" }), GITHUB);
assert.deepEqual(resolveAppUpdateFeed({ source: "", relayUrl: DEFAULT_APP_UPDATE_RELAY_URL }), GITHUB);
assert.deepEqual(
  resolveAppUpdateFeed({ source: "ecs" }),
  { source: "relay", url: DEFAULT_APP_UPDATE_RELAY_URL, token: "" },
  "选了 ecs 但没填地址 → 用内置 ECS 地址",
);
assert.deepEqual(resolveAppUpdateFeed({ source: "ecs", relayUrl: "  " }), {
  source: "relay",
  url: DEFAULT_APP_UPDATE_RELAY_URL,
  token: "",
});
assert.deepEqual(
  resolveAppUpdateFeed({ source: "ecs", relayUrl: "http://relay.whomidas.cn:10445/download/app/", token: " t1 " }),
  { source: "relay", url: "http://relay.whomidas.cn:10445/download/app/", token: "t1" },
  "自定义地址与令牌（令牌 trim，原样透传）",
);
// env 覆盖：不选 ecs 也生效（临时调试/自建镜像用）
assert.deepEqual(
  resolveAppUpdateFeed({ overrideUrl: "https://relay.example.com/download/app/", source: "github" }),
  { source: "relay", url: "https://relay.example.com/download/app/", token: "" },
);
// 非 http(s) 的自定义地址不算数 → 落回内置默认，而不是把非法值交给 electron-updater
assert.deepEqual(resolveAppUpdateFeed({ source: "ecs", relayUrl: "ftp://nope/" }), {
  source: "relay",
  url: DEFAULT_APP_UPDATE_RELAY_URL,
  token: "",
});
assert.deepEqual(resolveAppUpdateFeed({ overrideUrl: "不是地址" }), GITHUB);
assert.equal(APP_UPDATE_ECS_PROBE_TIMEOUT_MS, 5000, "ECS 预探测必须是 5s（修「干等 60s」的关键）");
assert.ok(DEFAULT_APP_UPDATE_RELAY_URL.endsWith(APP_UPDATE_RELAY_PATH));

// --- 旧行为迁移：通道地址 → 镜像 feed（升级过来的机器不能丢 ECS 更新）-------------
assert.deepEqual(legacyAppUpdateSource("wss://aliyun-ecs.tail38d5a.ts.net:9443/ws", " chan-token "), {
  url: "https://aliyun-ecs.tail38d5a.ts.net:9443/download/app/",
  token: "chan-token",
});
assert.deepEqual(legacyAppUpdateSource("ws://47.97.28.110:10445/ws"), {
  url: "http://47.97.28.110:10445/download/app/",
  token: "",
});
assert.equal(legacyAppUpdateSource(""), null, "没配过中继 → 不产生迁移结果");
assert.equal(legacyAppUpdateSource("不是地址"), null);
assert.equal(legacyAppUpdateSource("ftp://host/ws"), null, "非 http(s) 一律不算镜像源");

// --- 路径常量与两端用法一致 -----------------------------------------------------
assert.equal(APP_UPDATE_RELAY_PATH, "/download/app/");
const publisher = read("scripts", "publish-release.mjs");
assert.match(publisher, /RELAY_APP_DIR = process\.env\.MPI_RELAY_APP_DIR \|\| '\S*\/download\/app'/, "publish-release.mjs 的中继目录尾段必须是 /download/app");
for (const name of ["latest.yml", "MPI-Setup-${version}.exe", "MPI-Setup-${version}.exe.blockmap"]) {
  assert.ok(publisher.includes(name), `publish-release.mjs 必须镜像 ${name}`);
}

// 客户端：源由配置决定（不再看通道列表）、短超时预探测、令牌走 Authorization 头
const updater = read("src", "main", "app-updater.ts");
assert.match(updater, /resolveAppUpdateFeed/);
assert.match(updater, /APP_UPDATE_ECS_PROBE_TIMEOUT_MS/);
assert.match(updater, /async function probeRelayFeed/);
assert.match(updater, /AbortSignal\.timeout\(/, "预探测必须有超时信号");
assert.match(updater, /requestHeaders = target\.token \? \{ Authorization: `Bearer \$\{target\.token\}` \} : null/, "中继源必须带上授权令牌（check 与下载共用）");
assert.doesNotMatch(updater, /relayUpdateFeedUrl|pickRelayFeedUrl|effectiveChannels/, "更新源不许再依赖中继通道列表（2026-10-16 解耦）");
assert.match(updater, /staleRelay/, "镜像落后（版本比当前旧）时应继续问 GitHub");

// 配置层：三个新字段 + 一次性迁移接线（迁移只用「还没设过 source」的机器跑）
const config = read("src", "main", "config.ts");
assert.match(config, /appUpdateSource\?: "github" \| "ecs"/);
assert.match(config, /legacyAppUpdateSource\(/);
assert.match(config, /parsed\.appUpdateSource !== "ecs" && parsed\.appUpdateSource !== "github"/);

// 中继：/download/app/* 的软门控（默认放行、显式 strict 才 401）
const relay = read("mobile", "relay", "index.mjs");
assert.match(relay, /accept-ranges/, "中继静态服务必须声明 accept-ranges");
assert.match(relay, /content-range/, "中继静态服务必须回 Content-Range");
assert.match(relay, /RELAY_APP_TOKENS/, "镜像门控的令牌源");
assert.match(relay, /RELAY_APP_MIRROR_STRICT/);
assert.match(relay, /if \(!APP_MIRROR_STRICT\) return false;/, "软门控必须放行（旧客户端不带令牌）");

console.log("app-update-feed: 全部检查通过");
