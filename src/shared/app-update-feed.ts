/**
 * 桌面端自更新 feed 地址的推导（纯函数，无 electron 依赖，便于单测）。
 *
 * 约定：中继静态目录里镜像桌面安装包三件套 —— `latest.yml` + `MPI-Setup-<v>.exe` +
 * `.blockmap`，由 `scripts/publish-release.mjs` 推送（`RELAY_APP_DIR`）、
 * `src/main/app-updater.ts` 消费（electron-updater 的 generic provider 会读
 * `<feed>/latest.yml`）。两侧路径必须一致，否则客户端永远查不到更新。
 */

/** 中继静态目录内的桌面安装包镜像路径（`scripts/publish-release.mjs` 的 RELAY_APP_DIR 尾段）。 */
export const APP_UPDATE_RELAY_PATH = "/download/app/";

/**
 * **内置**的 ECS 中继镜像地址（`appUpdateEcsUrl` 留空时用它）。
 *
 * 为什么现在可以内置：自更新源不再由「手机远程控制」的通道列表决定（2026-10-16 改），
 * 而是这台机器上**显式授权**过才用（`appUpdateSource === "ecs"` + 令牌）。默认是 GitHub，
 * 所以别人的安装不会碰这台 ECS —— v0.9.5 担心的「别人装这台机器不受影响」仍然成立。
 *
 * 用 IP 而不是域名：阿里云会按 Host 头里的未备案域名返回备案拦截页（同 mobileRelayUrl 的注释）。
 */
export const DEFAULT_APP_UPDATE_RELAY_URL = "http://47.97.28.110:10445" + APP_UPDATE_RELAY_PATH;

/** ECS 镜像预探测超时（毫秒）：实测 ECS 37ms 可达，5s 足够；超时即回退 GitHub。 */
export const APP_UPDATE_ECS_PROBE_TIMEOUT_MS = 5000;

/** 自更新源的输入（env / config / 旧字段迁移都归到这里，便于单测钉住）。 */
export interface AppUpdateFeedInput {
  /** `MPI_APP_UPDATE_URL` 临时覆盖（最高优先级，只影响到配了它的进程）。 */
  overrideUrl?: string | null;
  /** `config.appUpdateSource`：`ecs` = 这台机器已授权走 ECS；其它/缺省 = 只用 GitHub。 */
  source?: string | null;
  /** `config.appUpdateEcsUrl`；留空 = 用 `DEFAULT_APP_UPDATE_RELAY_URL`。 */
  relayUrl?: string | null;
  /** `config.appUpdateEcsToken`；空 = 不带 Authorization（中继软门控下也放行）。 */
  token?: string | null;
}

/** 本次要用的更新源（`relay` 时 `url` 一定非空）。 */
export interface AppUpdateFeedTarget {
  source: "relay" | "github";
  /** relay 源的 feed 基地址（以 `/` 结尾）。 */
  url: string | null;
  /** 授权令牌（原样透传给中继的 `Authorization: Bearer`，不做任何加工）。 */
  token: string;
}

/** `http(s)://host[:port]/path/`：非法（非 http(s)/解析失败）返回 null，末尾补 `/`。 */
function normalizeFeedUrl(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * 解析本次自更新要用的源。
 *
 * 优先级：`MPI_APP_UPDATE_URL` 覆盖（视为 relay）> `appUpdateSource === "ecs"`（地址取
 * `appUpdateEcsUrl`，留空/非法则退回内置默认）> GitHub。
 * 注意「授权」就在这里：没显式选 `ecs` 的机器**根本不会去探测 ECS 镜像**。
 */
export function resolveAppUpdateFeed(input: AppUpdateFeedInput): AppUpdateFeedTarget {
  const token = String(input.token || "").trim();
  const override = normalizeFeedUrl(input.overrideUrl);
  if (override) return { source: "relay", url: override, token };
  if (String(input.source || "").trim() === "ecs") {
    return {
      source: "relay",
      url: normalizeFeedUrl(input.relayUrl) || DEFAULT_APP_UPDATE_RELAY_URL,
      token,
    };
  }
  return { source: "github", url: null, token };
}

/**
 * **旧行为迁移**（2026-10-16）：中继主机上行地址（+ 该通道的准入令牌）→ 自更新源。
 *
 * 改造前自更新源是从「中继通道列表」推的（`pickRelayFeedUrl`），改造后它有了自己的配置项；
 * 升级过来的机器不能因此丢掉 ECS 更新（小版本不推 GitHub，丢了就永远查不到），所以
 * **只在 `appUpdateSource` 还没值时**用这里的结果补一次（之后完全解耦）。
 * 返回 null = 不是 ws(s) 地址 / 没配过中继 → 保持 GitHub。
 */
export function legacyAppUpdateSource(
  hostUrl: string | null | undefined,
  token?: string | null,
): { url: string; token: string } | null {
  const url = relayAppUpdateFeedUrl(hostUrl);
  if (!url) return null;
  return { url, token: String(token || "").trim() };
}

/**
 * 中继配置（`wss://host/ws`，见设置页「中继地址」）→ electron-updater generic feed
 * （`https://host/download/app/`）。空 / 非法 / 非 ws(s) 一律 null = 直接走 GitHub。
 *
 * 注意端口要保留：`wss://host:9443/ws` → `https://host:9443/download/app/`
 * （中继的 TLS 监听与明文监听是不同端口）。
 */
export function relayAppUpdateFeedUrl(configuredRelayUrl: string | null | undefined): string | null {
  const raw = String(configuredRelayUrl || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const scheme = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    if (scheme !== "https:" && scheme !== "http:") return null;
    return `${scheme}//${url.host}${APP_UPDATE_RELAY_PATH}`;
  } catch {
    return null;
  }
}
