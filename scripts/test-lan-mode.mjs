/**
 * 局域网直连模式（P2，见 docs/RELAY-SHARING.md §3.2）：
 * 桌面端自己拉一个只绑局域网的中继子进程，手机连内网地址即可远控（不依赖 Tailscale/公网）。
 *
 * 这里钉三件最容易出错的事：
 *   ① **挑网卡**——挑错（落到 VMware/WSL/Tailscale 的虚拟网段）的表现是「中继起来了但手机连不上」；
 *   ② **子进程参数**——必须用 ELECTRON_RUN_AS_NODE 让 Electron 当普通 Node 跑，且不带公网监听/准入 token；
 *   ③ **脚本路径**——开发在仓库里、打包在 resources/relay 下，两种情况都要能找到（找不到要报错而不是静默不干活）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { LAN_ATTACHMENT_PORT, LAN_RELAY_PORT, lanAttachmentBase, lanRelayUrl, localRelayUrl, pickLanAddress, resolveLanRelayEntry, startLanRelay, startLocalRelay } =
  await import("../src/main/lan-mode.ts");

const iface = (name, address, internal = false) => [name, [{ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24` }]];
const ifaces = (...entries) => Object.fromEntries(entries);

// ---- 1. 挑网卡 ----
{
  assert.deepEqual(
    pickLanAddress(
      ifaces(
        iface("Loopback", "127.0.0.1", true),
        iface("vEthernet (WSL)", "172.28.0.1"),
        iface("VMware Network Adapter VMnet8", "192.168.56.1"),
        iface("Tailscale", "100.67.5.31"),
        iface("以太网", "10.8.0.4"),
        iface("WLAN", "192.168.1.23"),
      ),
    ),
    { address: "192.168.1.23", iface: "WLAN" },
    "虚拟网卡/回环/tailnet 都要跳过，私网里 192.168 优先",
  );
  assert.deepEqual(
    pickLanAddress(ifaces(iface("以太网", "10.0.0.9"), iface("Wi-Fi", "192.168.31.7"))),
    { address: "192.168.31.7", iface: "Wi-Fi" },
    "192.168 优先于 10.x",
  );
  assert.deepEqual(pickLanAddress(ifaces(iface("eth0", "172.20.3.4"))), { address: "172.20.3.4", iface: "eth0" }, "172.16-31 也算私网");
  assert.equal(pickLanAddress(ifaces(iface("eth0", "169.254.10.5"))), null, "169.254 自分配地址不可用");
  assert.equal(pickLanAddress(ifaces(iface("docker0", "172.17.0.1"))), null, "只有虚拟网卡时不要硬挑（宁可不启 LAN 模式）");
  assert.equal(pickLanAddress({}), null, "没有网卡 → null（调用方据此报错）");
  console.log("ok 1 - 挑网卡：跳过虚拟/回环/自分配，私网优先");
}

// ---- 2. 地址形状 ----
{
  assert.equal(lanRelayUrl("192.168.1.23"), `ws://192.168.1.23:${LAN_RELAY_PORT}/ws`, "配对链接里给手机的中继地址");
  assert.equal(lanRelayUrl("192.168.1.23", 9100), "ws://192.168.1.23:9100/ws", "端口可配");
  assert.equal(lanAttachmentBase("192.168.1.23"), `http://192.168.1.23:${LAN_ATTACHMENT_PORT}`, "附件走内网端口");
  console.log("ok 2 - 地址形状（中继 ws / 附件 http）");
}

// ---- 3. 脚本路径：开发 vs 打包 ----
{
  const root = mkdtempSync(join(tmpdir(), "mpi-lan-"));
  try {
    // 开发：<repo>/mobile/relay/index.mjs
    const repo = join(root, "repo");
    mkdirSync(join(repo, "mobile", "relay"), { recursive: true });
    writeFileSync(join(repo, "mobile", "relay", "index.mjs"), "// relay\n");
    assert.equal(
      resolveLanRelayEntry({ isPackaged: false, resourcesPath: join(root, "nope"), appPath: repo }),
      join(repo, "mobile", "relay", "index.mjs"),
      "开发模式取仓库里的脚本",
    );
    // 打包：<resources>/relay/index.mjs（package.json 的 build.extraResources 会把它放那里）
    const resources = join(root, "resources");
    mkdirSync(join(resources, "relay"), { recursive: true });
    writeFileSync(join(resources, "relay", "index.mjs"), "// relay\n");
    assert.equal(
      resolveLanRelayEntry({ isPackaged: true, resourcesPath: resources, appPath: repo }),
      join(resources, "relay", "index.mjs"),
      "打包模式取 resources/relay 下的脚本",
    );
    // 打包但 extraResources 没生效 → null（调用方报错，而不是静默不起）
    assert.equal(resolveLanRelayEntry({ isPackaged: true, resourcesPath: join(root, "empty"), appPath: repo }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("ok 3 - 中继脚本路径：开发走仓库、打包走 extraResources，找不到返回 null");
}

// ---- 4. 拉子进程：参数与失败态 ----
{
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} };
  };
  const entry = join(tmpdir(), "fake-relay-entry.mjs");
  writeFileSync(entry, "// fake\n");
  try {
    const ok = startLanRelay({
      entryPath: entry,
      port: 9123,
      spawnImpl: fakeSpawn,
      interfaces: ifaces(iface("WLAN", "192.168.5.6")),
    });
    assert.equal(ok.status.enabled, true, "有网卡 + 有脚本 → 应启动");
    assert.equal(ok.status.url, "ws://192.168.5.6:9123/ws");
    assert.equal(ok.status.attachmentBase, "http://192.168.5.6:8899");
    const call = calls.at(-1);
    assert.equal(call.args.at(-1), entry, "脚本路径作为参数传给 node");
    assert.equal(call.opts.env.ELECTRON_RUN_AS_NODE, "1", "Electron 要当普通 Node 跑（打包版没有独立 node）");
    assert.equal(call.opts.env.RELAY_HOST, "0.0.0.0", "局域网内要有可达的监听地址");
    assert.equal(call.opts.env.RELAY_PORT, "9123");
    assert.equal(call.opts.env.RELAY_PLAIN_PORT, "", "局域网模式不需要公网明文监听");
    assert.equal(call.opts.env.RELAY_HOST_TOKENS, "", "局域网模式不启用准入（同网段即可达）");

    // 没有可用网卡 → 不启动，并给出可读原因（否则用户只会看到「手机连不上」）
    const noIface = startLanRelay({ entryPath: entry, spawnImpl: fakeSpawn, interfaces: {} });
    assert.equal(noIface.status.enabled, false);
    assert.match(noIface.status.lastError || "", /网卡/, "要说清是找不到网卡");
    assert.equal(calls.length, 1, "没有网卡时不该真去拉子进程");

    // 脚本缺失 → 不启动
    const noEntry = startLanRelay({ entryPath: null, spawnImpl: fakeSpawn, interfaces: ifaces(iface("WLAN", "192.168.5.6")) });
    assert.equal(noEntry.status.enabled, false);
    assert.match(noEntry.status.lastError || "", /找不到中继脚本/);
  } finally {
    rmSync(entry, { force: true });
  }
  console.log("ok 4 - 子进程参数（RUN_AS_NODE / 监听 / 无准入）与两种失败态");
}

// ---- 5. 不变量：LAN 模式不给配对票塞 token，也不改中继准入 ----
{
  const { readFileSync } = await import("node:fs");
  const ipc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
  assert.match(
    ipc,
    /mobileRelayUrl: \(\) => phoneTicketAddresses\(\)\[0\]/,
    "配对票地址改由通道列表算出（局域网通道已置顶；优先级语义见 test-relay-channels）",
  );
  const lan = readFileSync(new URL("../src/main/lan-mode.ts", import.meta.url), "utf8");
  assert.ok(!/remoteRelayToken/.test(lan), "LAN 模块不该碰中继准入 token");
  console.log("ok 5 - 配对票：LAN 模式给内网地址；LAN 模块不碰准入 token");
}

// ---- 6. 常驻本机中继（S0）：绑回环 / 绑全网卡，广告与否只影响「手机地址」----
{
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} };
  };
  const entry = join(tmpdir(), "fake-local-relay-entry.mjs");
  writeFileSync(entry, "// fake\n");
  try {
    // ① 局域网模式关（只服务 CF 隧道/主机上行）：绑回环，**不广告**内网地址，但没有网卡也要起。
    const off = startLocalRelay({
      entryPath: entry,
      port: 9201,
      bindHost: "127.0.0.1",
      advertiseLan: false,
      spawnImpl: fakeSpawn,
      interfaces: ifaces(iface("WLAN", "192.168.5.6")),
    });
    assert.equal(off.status.enabled, true, "局域网模式关着也要常驻（CF 保底路依赖它）");
    assert.equal(off.status.url, null, "关着时不广告内网地址（配对票要回落到公网中继）");
    assert.equal(off.status.attachmentBase, null, "不广告附件内网基地址");
    assert.equal(off.status.localUrl, `ws://127.0.0.1:9201/ws`, "回环入口总是可用（隧道/上行 #2 指向它）");
    assert.equal(off.status.bindHost, "127.0.0.1");
    assert.equal(off.status.advertiseLan, false);
    assert.equal(calls.at(-1).opts.env.RELAY_HOST, "127.0.0.1", "只服务本机时不要绑 0.0.0.0");
    assert.equal(localRelayUrl(9201), "ws://127.0.0.1:9201/ws", "回环地址形状");

    // ② 没有任何可用网卡 + 不要求网卡 → 仍要起来（只是没内网地址可广告）
    const noIface = startLocalRelay({ entryPath: entry, bindHost: "127.0.0.1", advertiseLan: false, spawnImpl: fakeSpawn, interfaces: {} });
    assert.equal(noIface.status.enabled, true, "挑不到网卡不该阻止中继常驻");
    assert.equal(noIface.status.localUrl, `ws://127.0.0.1:${LAN_RELAY_PORT}/ws`, "默认端口");

    // ③ 局域网模式开：绑 0.0.0.0 + 广告内网地址（新入口仍保有旧语义）
    const on = startLocalRelay({
      entryPath: entry,
      port: 9202,
      bindHost: "0.0.0.0",
      advertiseLan: true,
      spawnImpl: fakeSpawn,
      interfaces: ifaces(iface("WLAN", "192.168.7.8")),
    });
    assert.equal(on.status.url, "ws://192.168.7.8:9202/ws");
    assert.equal(on.status.attachmentBase, `http://192.168.7.8:${LAN_ATTACHMENT_PORT}`);
    assert.equal(calls.at(-1).opts.env.RELAY_HOST, "0.0.0.0");

    // ④ 广告但没网卡 → 起来 + 给出可读原因
    const warn = startLocalRelay({ entryPath: entry, bindHost: "0.0.0.0", advertiseLan: true, spawnImpl: fakeSpawn, interfaces: {} });
    assert.equal(warn.status.enabled, true);
    assert.equal(warn.status.url, null);
    assert.match(warn.status.lastError || "", /网卡/, "要说清为什么手机连不上");
  } finally {
    rmSync(entry, { force: true });
  }
  console.log("ok 6 - 常驻本机中继：绑回环/全网卡，广告与否只影响手机地址");
}

// ---- 7. VAPID 密钥与静态目录要显式注入子进程（否则应用更新即失效推送）----
{
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} };
  };
  const entry = join(tmpdir(), "fake-vapid-relay-entry.mjs");
  writeFileSync(entry, "// fake\n");
  try {
    startLocalRelay({
      entryPath: entry,
      bindHost: "127.0.0.1",
      advertiseLan: false,
      spawnImpl: fakeSpawn,
      interfaces: {},
      vapidKeyFile: "C:/u/relay-vapid.json",
      staticDir: "C:/static",
    });
    const env = calls.at(-1).opts.env;
    assert.equal(env.RELAY_VAPID_KEY_FILE, "C:/u/relay-vapid.json", "VAPID 密钥路径要传给子进程");
    assert.equal(env.RELAY_STATIC_DIR, "C:/static", "静态目录（托管 PWA）要传给子进程");

    startLocalRelay({ entryPath: entry, spawnImpl: fakeSpawn, interfaces: {} });
    assert.equal(calls.at(-1).opts.env.RELAY_STATIC_DIR, "", "不传静态目录 = 不托管");
  } finally {
    rmSync(entry, { force: true });
  }

  // 源码级守卫：主进程必须把 VAPID 指到 userData，而不是安装目录（更新即换密钥 → 推送全失效）
  const { readFileSync } = await import("node:fs");
  const ipc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
  assert.match(
    ipc,
    /vapidKeyFile: join\(getConfigDir\(\), "relay-vapid\.json"\)/,
    "本机中继的 VAPID 密钥必须落在 userData 下",
  );
  console.log("ok 7 - VAPID 密钥与静态目录：显式注入子进程，密钥落 userData");
}

console.log("lan-mode tests passed");
