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

/** ECS 镜像预探测超时（毫秒）：实测 ECS 37ms 可达，5s 足够；超时即回退 GitHub。 */
export const APP_UPDATE_ECS_PROBE_TIMEOUT_MS = 5000;

/** 自更新源的输入（env / config / 旧字段迁移都归到这里，便于单测钉住）。 */
export interface AppUpdateFeedInput {
  /** `MPI_APP_UPDATE_URL` 临时覆盖（最高优先级，只影响到配了它的进程）。 */
  overrideUrl?: string | null;
  /** `config.customRelayUrl`：填了就说明用户用了自己的中继（它不镜像安装包）→ 更新走 GitHub。 */
  customRelayUrl?: string | null;
  /**
   * 内置服务器的镜像地址（由调用方从 `shared/builtin-server.ts` 解出来传进来）。
   * 这样本模块保持零依赖：地址从哪来是「内置描述」的事，这里只管「该不该用、用哪个」。
   */
  mirrorUrl?: string | null;
  /**
   * `config.serverAuthCode`：**授权码**。它同时是两件事的凭证：
   *   · 主机→中继注册（转发对话，服务端 `RELAY_HOST_TOKENS` 校验）；
   *   · 镜像下载（`Authorization: Bearer`，服务端 `RELAY_APP_TOKENS` 校验）。
   * 空 = 没授权 → 不用内置服务器（也不会去探测它的镜像）。
   */
  authCode?: string | null;
}

/** 本次要用的更新源（`relay` 时 `url` 一定非空）。 */
export interface AppUpdateFeedTarget {
  source: "relay" | "github";
  /** relay 源的 feed 基地址（以 `/` 结尾）。 */
  url: string | null;
  /** 授权码（原样透传给中继的 `Authorization: Bearer`，不做任何加工）。 */
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
 * 优先级：`MPI_APP_UPDATE_URL` 覆盖（视为 relay）> **没配自定义中继**
 * 且**有授权码**（镜像地址来自内置服务器，见 shared/builtin-server.ts）> GitHub。
 * 注意「授权」就在这里：没码的机器**根本不会去探测 ECS 镜像**（别人的安装不受影响），
 * 而自定义服务器不镜像安装包 → 也走 GitHub。
 */
export function resolveAppUpdateFeed(input: AppUpdateFeedInput): AppUpdateFeedTarget {
  const token = String(input.authCode || "").trim();
  const override = normalizeFeedUrl(input.overrideUrl);
  if (override) return { source: "relay", url: override, token };
  if (!String(input.customRelayUrl || "").trim() && token) {
    const url = normalizeFeedUrl(input.mirrorUrl);
    if (url) return { source: "relay", url, token };
  }
  return { source: "github", url: null, token };
}
