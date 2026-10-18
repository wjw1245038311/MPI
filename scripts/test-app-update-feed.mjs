/**
 * 自更新源解析（L1）：`shared/app-update-feed.ts` + 内置服务器（`shared/builtin-server.ts`）。
 *
 * 覆盖最容易被改坏的两点：
 *   ① **没授权码就不许碰内置服务器**——否则别人装的 MPI 会去敲这台私有 ECS
 *      （v0.9.5 定下的原则），这条必须由测试锁住；
 *   ② 内置描述必须能解开、地址形状正确（混淆常量被谁重新生成过也不会静默失效）。
 *
 * 真正的 electron-updater 探测/回退流程（5s 预探测 → GitHub）跑不了 L1：
 * app-updater.ts 依赖 electron 与 electron-updater，只能在实机验证；
 * 这里对它做源码级断言（防回退到「先等 60s 才回退」的老行为）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_UPDATE_ECS_PROBE_TIMEOUT_MS, APP_UPDATE_RELAY_PATH, resolveAppUpdateFeed } from "../src/shared/app-update-feed.ts";
import { builtinServer } from "../src/shared/builtin-server.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

// --- 内置服务器：能解开、形状正确 ------------------------------------------------
const builtin = builtinServer();
assert.ok(builtin, "内置服务器描述必须能解开（密文或密钥改坏了这里会炸）");
assert.ok(builtin.hostUplinks.length >= 1, "至少要有一条主机上行候选");
for (const url of builtin.hostUplinks) assert.match(url, /^wss?:\/\//, `主机上行必须是 ws(s)：${url}`);
for (const url of builtin.phoneUrls) assert.match(url, /^wss?:\/\//, `手机地址必须是 ws(s)：${url}`);
assert.match(builtin.mirrorUrl, /^https?:\/\/.+\/download\/app\/$/, "镜像地址必须以 /download/app/ 结尾");
// 主机上行第一候选是 tailnet 的 TLS 入口（本机在有 tailnet 时走它），末位是公网明文兜底
assert.match(builtin.hostUplinks[0], /^wss:\/\//);
assert.match(builtin.hostUplinks[builtin.hostUplinks.length - 1], /^ws:\/\//);
// 手机侧必须同时给明文（原生 App）与 TLS（PWA 在 HTTPS 页面下不能连明文 ws）
assert.ok(builtin.phoneUrls.some((url) => url.startsWith("ws://")), "手机候选里要有公网明文");
assert.ok(builtin.phoneUrls.some((url) => url.startsWith("wss://")), "手机候选里要有公网 TLS");

// --- 源解析：默认 GitHub，有授权码才走内置镜像 ------------------------------------
const GITHUB = { source: "github", url: null, token: "" };
assert.deepEqual(resolveAppUpdateFeed({}), GITHUB, "什么都没配 → 只用 GitHub");
assert.deepEqual(
  resolveAppUpdateFeed({}),
  GITHUB,
  "选了内置服务器但没授权码 → 不许去探测它的镜像",
);
assert.deepEqual(resolveAppUpdateFeed({ authCode: "   " }), GITHUB, "空白授权码同样不算授权");
assert.deepEqual(
  resolveAppUpdateFeed({ customRelayUrl: "wss://relay.example.com/ws", authCode: "code-1" }),
  { source: "github", url: null, token: "code-1" },
  "自定义服务器不镜像安装包 → 更新走 GitHub",
);
assert.deepEqual(
  resolveAppUpdateFeed({ authCode: " code-1 ", mirrorUrl: builtin.mirrorUrl }),
  { source: "relay", url: builtin.mirrorUrl, token: "code-1" },
  "内置 + 有码 → 用它自己的镜像（令牌 trim 后原样透传）",
);
assert.deepEqual(
  resolveAppUpdateFeed({ authCode: "code-1", mirrorUrl: "" }),
  { source: "github", url: null, token: "code-1" },
  "内置描述坏掉（取不到镜像地址）→ 退回 GitHub，而不是崩",
);
// env 覆盖：调试/自建镜像用，不选内置也生效
assert.deepEqual(
  resolveAppUpdateFeed({ overrideUrl: "https://relay.example.com/download/app/", customRelayUrl: "wss://relay.example.com/ws" }),
  { source: "relay", url: "https://relay.example.com/download/app/", token: "" },
);
assert.deepEqual(resolveAppUpdateFeed({ overrideUrl: "不是地址" }), GITHUB, "非法覆盖地址 → 当作没有");
assert.equal(APP_UPDATE_ECS_PROBE_TIMEOUT_MS, 5000, "镜像预探测必须是 5s（修「干等 60s」的关键）");
assert.equal(APP_UPDATE_RELAY_PATH, "/download/app/");

// --- 混淆不是安全边界，但也不能是明文 --------------------------------------------
const builtinSource = read("src", "shared", "builtin-server.ts");
assert.match(builtinSource, /createDecipheriv\("aes-256-gcm"/, "内置描述必须走 GCM 解密");
assert.doesNotMatch(builtinSource, /47\.97\.28\.110/, "内置描述里不许出现明文地址（否则「加密内置」名存实亡）");
assert.match(builtinSource, /不是安全机制/, "必须写明这层只是混淆");

// --- 配置层：新字段 + 旧字段迁移 --------------------------------------------------
const config = read("src", "main", "config.ts");
assert.match(config, /customRelayUrl\?: string/, "配置项：自定义中继（填了 → 更新走 GitHub）");
assert.match(config, /customRelayToken\?: string/);
assert.match(config, /serverAuthCode\?: string/);
assert.match(config, /legacy\.appUpdateEcsToken/, "旧的 appUpdate* 必须有迁移路径（把令牌当激活码带走）");
assert.match(config, /for \(const key of \[/, "旧字段要一次性抹掉，不能两套概念共存");
assert.match(config, /customRelayUrl = url/, "旧通道列表里的公网地址要迁成 customRelay");

// --- 客户端：源跟随服务器、短超时预探测、令牌走 Authorization 头 --------------------
const updater = read("src", "main", "app-updater.ts");
assert.match(updater, /resolveAppUpdateFeed/);
assert.match(updater, /mirrorUrl: builtinServer\(\)\?\.mirrorUrl/, "镜像地址必须来自内置描述");
assert.match(updater, /APP_UPDATE_ECS_PROBE_TIMEOUT_MS/);
assert.match(updater, /async function probeRelayFeed/);
assert.match(updater, /AbortSignal\.timeout\(/, "预探测必须有超时信号");
assert.match(
  updater,
  /requestHeaders = target\.token \? \{ Authorization: `Bearer \$\{target\.token\}` \} : null/,
  "内置服务器必须带上授权码（check 与下载共用）",
);
assert.doesNotMatch(updater, /relayUpdateFeedUrl|pickRelayFeedUrl|effectiveChannels/, "更新源不许再依赖中继通道列表");
assert.match(updater, /staleRelay/, "镜像落后（版本比当前旧）时应继续问 GitHub");

// 未激活（无授权码 → 只能走 GitHub）时的网络失败：必须给可读兜底，
// 而不是把 Chromium 的 `net::ERR_CONNECTION_RESET` 原样丢到界面上。
assert.match(updater, /ERR_CONNECTION_RESET/, "Chromium 的连接重置错误必须有映射");
assert.match(updater, /未激活内置服务器时/, "只能走 GitHub 时要提示可点「打开发布页」手动下载");
assert.match(updater, /function friendlyUpdaterError\(message: unknown, noRelay = false\)/, "错误映射要区分「只有 GitHub 一条路」");

// --- 中继：/download/app/* 的准入（默认软门控、显式 strict 才 401）----------------
const relay = read("mobile", "relay", "index.mjs");
assert.match(relay, /accept-ranges/, "中继静态服务必须声明 accept-ranges");
assert.match(relay, /content-range/, "中继静态服务必须回 Content-Range");
assert.match(relay, /RELAY_APP_TOKENS/, "镜像门控的令牌源");
assert.match(relay, /RELAY_APP_MIRROR_STRICT/);
assert.match(relay, /if \(!APP_MIRROR_STRICT\) return false;/, "软门控必须放行（旧客户端不带令牌）");
// 主机准入（授权码的另一半用途）：中继必须支持 token 校验，客户端必须带上
assert.match(relay, /RELAY_HOST_TOKENS|RELAY_TOKEN_FILE/, "中继必须支持主机准入");
const mainIpc = read("src", "main", "ipc.ts");
assert.match(mainIpc, /relayToken: channel\.token/, "主机上行必须把授权码作为准入 token 带上");
assert.match(mainIpc, /id: "builtin"/, "内置服务器要合成一条通道（否则授权码无处可带）");

// --- 发布脚本推送目录与客户端读取路径一致 -----------------------------------------
const publisher = read("scripts", "publish-release.mjs");
assert.match(publisher, /RELAY_APP_DIR = process\.env\.MPI_RELAY_APP_DIR \|\| '\S*\/download\/app'/, "publish-release.mjs 的中继目录尾段必须是 /download/app");
for (const name of ["latest.yml", "MPI-Setup-${version}.exe", "MPI-Setup-${version}.exe.blockmap"]) {
  assert.ok(publisher.includes(name), `publish-release.mjs 必须镜像 ${name}`);
}

console.log("app-update-feed: 全部检查通过");
