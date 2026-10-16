/**
 * 本机中继（常驻）与局域网直连模式（见 docs/RELAY-SHARING.md §3.2、方案 `实施计划-C档多通道.md`）。
 *
 * 需求（用户原话）：桌面端与手机端**网络能通**，手机就能远端操作桌面端。
 * 同网段时最省事的通路不是 Tailscale 也不是公网中继，而是：**桌面端自己起一个中继**。
 *
 * 两种用途共用**同一个中继进程**，只是「广告给手机的地址」不同：
 *   · 局域网入口：`ws://<内网IP>:<port>/ws`  —— 手机同网段时最快（毫秒级）
 *   · 本机入口：`ws://127.0.0.1:<port>/ws`    —— 给 CF 隧道 / 主机上行 #2 用（公网保底路）
 *
 * 因此本进程**常驻**（应用启动即起，不再由「局域网模式」开关决定起停）；
 * `lanModeEnabled` 退化为「要不要把内网地址广告进配对票」：
 *   · 开 → 绑 `0.0.0.0`（同网段可达）+ 广告内网地址
 *   · 关 → 绑 `127.0.0.1`（只有本机的 CF 隧道能连）+ 不广告
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
/** 本机中继默认端口。 */
export const LAN_RELAY_PORT = 9001;
/** 只服务本机（CF 隧道 / 主机上行）时的绑定地址。 */
export const LOCAL_RELAY_HOST = "127.0.0.1";
/** 局域网模式下的绑定地址（同网段可达）。 */
export const LAN_RELAY_BIND_HOST = "0.0.0.0";

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
 * 私有网段（192.168 > 10 > 172.16–31），同档里取第一个。找不到 → null（不广告内网地址）。
 *
 * 抽成纯函数是因为「挑错网卡」的表现很有迷惑性：中继起来了、日志也正常，但手机连不上
 * （连到了 VMware 的虚拟网段）。
 */
/**
 * 全部可广告的内网地址（有序，与 `pickLanAddress` 同一套过滤与排序）。
 *
 * 为什么要全给：手机可能在**另一张网卡**的网段上（典型：桌面自己开热点 → 手机在
 * `192.168.137.x`，而以太网是 `10.x`）。只广告一个地址时手机会试不通并回落到公网，
 * 明明"就在同一个热点上"却走了远路。主流做法（WebRTC ICE 的 host candidates）也是把所有
 * 网卡候选都报出来，由客户端挑通的。
 */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): LanAddress[] {
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
  if (!candidates.length) return [];
  // 公有地址（rank 3）理论上也能用，但更可能是热点/异常环境——排在私网候选之后。
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates.map((c) => c.entry);
}

/** 挑一个（列表首个）：仍是配对票里排第一的那个内网地址。 */
export function pickLanAddress(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): LanAddress | null {
  return lanAddresses(ifaces)[0] ?? null;
}

/** 配对链接里给手机的中继地址（内网入口）。 */
export const lanRelayUrl = (address: string, port: number = LAN_RELAY_PORT): string => `ws://${address}:${port}/ws`;

/** 本机回环入口——CF 隧道与主机上行 #2 指向它。 */
export const localRelayUrl = (port: number = LAN_RELAY_PORT): string => `ws://${LOCAL_RELAY_HOST}:${port}/ws`;

/** 附件直连基地址（走内网，不经公网、不需要反向隧道）。 */
export const lanAttachmentBase = (address: string, port: number = LAN_ATTACHMENT_PORT): string => `http://${address}:${port}`;

export interface LanRelayStatus {
  /** 中继子进程是否已拉起。 */
  enabled: boolean;
  /**
   * **广告给手机的内网地址**——`advertiseLan` 且挑到网卡时才有。
   * LAN 关闭时为 null（配对票因此回落到配置里的公网中继）。进程仍在跑。
   */
  url: string | null;
  /** 附件直连基地址（同上网卡；不广告时为 null）。 */
  attachmentBase: string | null;
  /** 本机回环入口（进程起来后总是可用）——主机上行 #2 / CF 隧道用。 */
  localUrl: string | null;
  port: number;
  /** 挑到的内网网卡地址（首个候选；仅用于广告，没挑到不影响进程）。 */
  address: string | null;
  /**
   * **全部**内网候选地址（有序）：配对票与通道列表都按它逐个给出，
   * 让手机在"换了网卡/换了网段"时仍能试到其中一条（见 `lanAddresses`）。
   */
  urls: string[];
  /** 实际绑定地址：`0.0.0.0`（LAN 开）或 `127.0.0.1`（LAN 关）。 */
  bindHost: string;
  /** 是否把内网地址广告给手机。 */
  advertiseLan: boolean;
  lastError: string | null;
}

export interface LocalRelayHandle {
  /** 子进程（用于 stop）。 */
  child: ChildProcess | null;
  status: LanRelayStatus;
  stop: () => void;
}

/** 旧名保留（既有调用方与测试沿用）。 */
export type LanRelayHandle = LocalRelayHandle;

export interface StartLocalRelayOptions {
  /** `mobile/relay/index.mjs` 的绝对路径（开发在仓库里，打包在 resources/relay 下）。 */
  entryPath: string | null;
  port?: number;
  /** 绑定地址，默认 `0.0.0.0`；只服务本机（CF 隧道）时用 `127.0.0.1`。 */
  bindHost?: string;
  /** 是否把内网地址广告给手机，默认 true。 */
  advertiseLan?: boolean;
  /**
   * 挑不到网卡时是否算失败。
   * 默认 false（进程照起，只是不广告内网地址）；
   * 局域网模式的旧入口 `startLanRelay` 传 true 以保持原语义。
   */
  requireLanAddress?: boolean;
  /**
   * Web Push 的 VAPID 密钥文件路径。**必须指到 userData 下**：
   * 中继默认把它写在脚本旁边（打包后在安装目录 `resources/relay/data/`），
   * 而应用一更新就换密钥 → 手机上已有推送订阅全部失效（订阅与密钥绑定）。
   */
  vapidKeyFile?: string;
  /** 静态目录（托管 PWA / 下载页）。空 = 不托管。 */
  staticDir?: string;
  /** 注入用（测试里换成假实现，不真的拉子进程）。 */
  spawnImpl?: typeof spawn;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  log?: (line: string) => void;
}

/**
 * 起一个本机中继子进程。
 *
 * 不做的事：不开 TLS（本机/局域网内，且控制通道本来就有应用层 E2E）、不配 host token
 * （这台中继只服务本机的手机；准入是公网中继那侧的事）。
 */
export function startLocalRelay(options: StartLocalRelayOptions): LocalRelayHandle {
  const log = options.log ?? (() => {});
  const port = options.port ?? LAN_RELAY_PORT;
  const bindHost = options.bindHost ?? LAN_RELAY_BIND_HOST;
  const advertiseLan = options.advertiseLan !== false;
  const requireLanAddress = options.requireLanAddress === true;
  const base: LanRelayStatus = {
    enabled: false,
    url: null,
    attachmentBase: null,
    localUrl: null,
    port,
    address: null,
    urls: [],
    bindHost,
    advertiseLan,
    lastError: null,
  };
  const empty: LocalRelayHandle = { child: null, status: base, stop: () => {} };

  if (!options.entryPath || !existsSync(options.entryPath)) {
    return { ...empty, status: { ...base, lastError: `找不到中继脚本（${options.entryPath ?? "-"}）` } };
  }
  const interfaces = options.interfaces ?? networkInterfaces();
  const lanPicks = lanAddresses(interfaces);
  const picked = lanPicks[0] ?? null;
  if (requireLanAddress && !picked) {
    return { ...empty, status: { ...base, lastError: "找不到可用的局域网网卡（手机连不上）" } };
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  let child: ChildProcess | null = null;
  try {
    child = spawnImpl(process.execPath, [options.entryPath], {
      env: {
        ...process.env,
        // Electron 当普通 Node 用（打包版没有独立的 node 可执行文件）。
        ELECTRON_RUN_AS_NODE: "1",
        RELAY_HOST: bindHost,
        RELAY_PORT: String(port),
        // 本机中继不需要公网明文监听，也不需要准入列表。
        RELAY_PLAIN_PORT: "",
        RELAY_HOST_TOKENS: "",
        // VAPID 密钥必须落在 userData（见选项注释）：否则应用更新即换密钥、推送订阅全失效。
        ...(options.vapidKeyFile ? { RELAY_VAPID_KEY_FILE: options.vapidKeyFile } : {}),
        // 静态目录：托管 PWA / 下载页（CF 路下同一域名既是界面又是通道）。
        RELAY_STATIC_DIR: options.staticDir || "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return { ...empty, status: { ...base, lastError: String((error as Error)?.message || error).slice(0, 120) } };
  }
  child.stdout?.on("data", (chunk: Buffer) => log(`local-relay ${chunk.toString().trim().slice(0, 160)}`));
  child.stderr?.on("data", (chunk: Buffer) => log(`local-relay ! ${chunk.toString().trim().slice(0, 160)}`));
  child.on("exit", (code) => log(`local-relay exited code=${code}`));

  const url = advertiseLan && picked ? lanRelayUrl(picked.address, port) : null;
  log(
    `local-relay starting on ${bindHost}:${port}` +
      (picked ? ` (lan ${picked.address} ${picked.iface})` : " (无可广告的局域网网卡)") +
      (lanPicks.length > 1 ? ` [候选 ${lanPicks.map((p) => p.address).join(",")}]` : "") +
      (url ? "" : " [不广告内网地址]"),
  );
  return {
    child,
    status: {
      enabled: true,
      url,
      attachmentBase: url && picked ? lanAttachmentBase(picked.address) : null,
      localUrl: localRelayUrl(port),
      port,
      address: picked?.address ?? null,
      // 全部候选（手机按序试；票里会逐个给出）
      urls: url ? lanPicks.map((item) => lanRelayUrl(item.address, port)) : [],
      bindHost,
      advertiseLan,
      lastError: !picked && advertiseLan ? "找不到可用的局域网网卡（手机连不上）" : null,
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
 * 局域网直连模式的入口（P2 语义**不变**）：要求挑到内网网卡，绑 `0.0.0.0`，广告内网地址。
 * 新代码请用 `startLocalRelay`（常驻 + 可选广告）。
 */
export function startLanRelay(
  options: Omit<StartLocalRelayOptions, "bindHost" | "advertiseLan" | "requireLanAddress">,
): LocalRelayHandle {
  return startLocalRelay({ ...options, bindHost: LAN_RELAY_BIND_HOST, advertiseLan: true, requireLanAddress: true });
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
