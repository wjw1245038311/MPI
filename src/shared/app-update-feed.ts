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
