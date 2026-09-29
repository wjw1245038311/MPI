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

const { LAN_ATTACHMENT_PORT, LAN_RELAY_PORT, lanAttachmentBase, lanRelayUrl, pickLanAddress, resolveLanRelayEntry, startLanRelay } =
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
    /mobileRelayUrl: \(\) => lanModeStatus\(\)\.url \|\| getConfig\(\)\.mobileRelayUrl/,
    "LAN 模式开着时配对票给内网地址；关着时回到配置里的公网中继",
  );
  const lan = readFileSync(new URL("../src/main/lan-mode.ts", import.meta.url), "utf8");
  assert.ok(!/remoteRelayToken/.test(lan), "LAN 模块不该碰中继准入 token");
  console.log("ok 5 - 配对票：LAN 模式给内网地址；LAN 模块不碰准入 token");
}

console.log("lan-mode tests passed");
