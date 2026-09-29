/**
 * 局域网直连模式（P2，见 docs/RELAY-SHARING.md §3.2）。
 *
 * 需求（用户原话）：桌面端与手机端**网络能通**，手机就能远端操作桌面端。
 * 同网段时最省事的通路不是 Tailscale 也不是公网中继，而是：**桌面端自己起一个中继**，
 * 手机连它的内网地址。好处：
 *   · 手机端**零改动**（它本来就把「中继地址」当 URL 用，配对链接里带的就是它）；
 *   · 附件也能同时切到内网地址（快，且不占公网带宽、不需要反向隧道）；
 *   · 完全离线可用（不依赖 Tailscale / 你的 ECS）。
 *
 * 固有取舍（必须对用户说清）：**没有推送通道**——Web Push 要经公网中继，纯局域网模式下
 * 手机在后台收不到「待批准」通知，只能回前台时同步。
 *
 * 实现方式：**拉起 `mobile/relay/index.mjs` 子进程**（用 `ELECTRON_RUN_AS_NODE=1` 让 Electron
 * 当普通 Node 跑它），而不是把中继代码拷进主进程——中继与 ECS 上跑的是**同一份文件**，
 * 不会出现两份实现漂移。打包时该目录走 `extraResources`（见 package.json 的 build.extraResources）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";

/** 附件服务监听的本地端口（与 ipc.ts 的 ATTACHMENT_HTTP_PORT 一致）。 */
export const LAN_ATTACHMENT_PORT = 8899;
/** 局域网中继默认端口。 */
export const LAN_RELAY_PORT = 9001;

export interface LanAddress {
  address: string;
  iface: string;
}

/** 明显不属于「手机能连到的那个网卡」的名字（虚拟网卡/隧道/WSL/容器）。 */
const VIRTUAL_IFACE = /(vethernet|vmware|virtualbox|hyper-v|loopback|tailscale|zerotier|wsl|docker|br-|veth|utun|tun\d|tap\d)/i;

/**
 * 从网卡列表里挑一个手机能连到的 IPv4。
 *
 * 规则（按优先级）：跳过 loopback / 未启用 / 169.254 自分配 / 虚拟网卡；然后偏好
 * 私有网段（192.168 > 10 > 172.16–31），同档里取第一个。找不到 → null（调用方别启 LAN 模式）。
 *
 * 抽成纯函数是因为「挑错网卡」的表现很有迷惑性：中继起来了、日志也正常，但手机连不上
 * （连到了 VMware 的虚拟网段）。
 */
export function pickLanAddress(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): LanAddress | null {
  const candidates: Array<{ entry: LanAddress; rank: number }> = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (!list || VIRTUAL_IFACE.test(name)) continue;
    for (const info of list) {
      if (!info || info.internal) continue;
      if (info.family !== "IPv4" && (info.family as unknown as number) !== 4) continue;
      const address = String(info.address || "");
      if (!address || address.startsWith("169.254.")) continue;
      const rank = address.startsWith("192.168.")
        ? 0
        : address.startsWith("10.")
          ? 1
          : /^172\.(1[6-9]|2\d|3[01])\./.test(address)
            ? 2
            : 3;
      candidates.push({ entry: { address, iface: name }, rank });
    }
  }
  if (!candidates.length) return null;
  // 公有地址（rank 3）理论上也能用，但更可能是热点/异常环境——只在没有私网候选时才用。
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0].entry;
}

/** 配对链接里给手机的中继地址。 */
export const lanRelayUrl = (address: string, port: number = LAN_RELAY_PORT): string => `ws://${address}:${port}/ws`;

/** 附件直连基地址（走内网，不经公网、不需要反向隧道）。 */
export const lanAttachmentBase = (address: string, port: number = LAN_ATTACHMENT_PORT): string => `http://${address}:${port}`;

export interface LanRelayStatus {
  enabled: boolean;
  /** 手机该连的地址（enabled 且起来了才有）。 */
  url: string | null;
  /** 附件直连基地址（同上网卡）。 */
  attachmentBase: string | null;
  port: number;
  address: string | null;
  lastError: string | null;
}

export interface LanRelayHandle {
  /** 子进程（用于 stop）。 */
  child: ChildProcess | null;
  status: LanRelayStatus;
  stop: () => void;
}

export interface StartLanRelayOptions {
  /** `mobile/relay/index.mjs` 的绝对路径（开发在仓库里，打包在 resources/relay 下）。 */
  entryPath: string | null;
  port?: number;
  /** 注入用（测试里换成假实现，不真的拉子进程）。 */
  spawnImpl?: typeof spawn;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  log?: (line: string) => void;
}

/**
 * 起一个只绑局域网的 relay 子进程。
 *
 * 不做的事：不开 TLS（局域网内、且控制通道本来就有应用层 E2E）、不配 host token
 * （这台中继只服务本机的手机；准入是公网中继那侧的事）。
 */
export function startLanRelay(options: StartLanRelayOptions): LanRelayHandle {
  const log = options.log ?? (() => {});
  const port = options.port ?? LAN_RELAY_PORT;
  const empty: LanRelayHandle = {
    child: null,
    status: { enabled: false, url: null, attachmentBase: null, port, address: null, lastError: null },
    stop: () => {},
  };
  if (!options.entryPath || !existsSync(options.entryPath)) {
    return { ...empty, status: { ...empty.status, lastError: `找不到中继脚本（${options.entryPath ?? "-"}）` } };
  }
  const interfaces = options.interfaces ?? networkInterfaces();
  const picked = pickLanAddress(interfaces);
  if (!picked) {
    return { ...empty, status: { ...empty.status, lastError: "找不到可用的局域网网卡（手机连不上）" } };
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  let child: ChildProcess | null = null;
  try {
    child = spawnImpl(process.execPath, [options.entryPath], {
      env: {
        ...process.env,
        // Electron 当普通 Node 用（打包版没有独立的 node 可执行文件）。
        ELECTRON_RUN_AS_NODE: "1",
        RELAY_HOST: "0.0.0.0",
        RELAY_PORT: String(port),
        // 局域网模式不需要公网明文监听，也不需要准入列表。
        RELAY_PLAIN_PORT: "",
        RELAY_HOST_TOKENS: "",
        RELAY_STATIC_DIR: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return { ...empty, status: { ...empty.status, lastError: String((error as Error)?.message || error).slice(0, 120) } };
  }
  child.stdout?.on("data", (chunk: Buffer) => log(`lan-relay ${chunk.toString().trim().slice(0, 160)}`));
  child.stderr?.on("data", (chunk: Buffer) => log(`lan-relay ! ${chunk.toString().trim().slice(0, 160)}`));
  child.on("exit", (code) => log(`lan-relay exited code=${code}`));
  log(`lan-relay starting on ${picked.address}:${port} (${picked.iface})`);
  return {
    child,
    status: {
      enabled: true,
      url: lanRelayUrl(picked.address, port),
      attachmentBase: lanAttachmentBase(picked.address),
      port,
      address: picked.address,
      lastError: null,
    },
    stop: () => {
      try {
        child?.kill();
      } catch {
        /* 已经退了 */
      }
    },
  };
}

/**
 * 打包/开发两种情况下的中继脚本路径。
 *
 * 开发：仓库里的 `mobile/relay/index.mjs`；打包：`extraResources` 复制到
 * `<resources>/relay/index.mjs`（见 package.json 的 build.extraResources）。
 */
export function resolveLanRelayEntry(args: { isPackaged: boolean; resourcesPath: string; appPath: string }): string | null {
  const packaged = join(args.resourcesPath, "relay", "index.mjs");
  if (args.isPackaged) return existsSync(packaged) ? packaged : null;
  const dev = join(args.appPath, "mobile", "relay", "index.mjs");
  return existsSync(dev) ? dev : null;
}
