/**
 * 新版本检测（PWA 自更新提示）。
 *
 * 为什么需要：手机壳里的 WebView 会一直活着——按返回键只是退到后台，从多任务
 * 里重新打开也不会触发页面重载，于是用户会长时间停留在旧 bundle 上（2026-09-15
 * 实测：中继 22:47 部署了新 UI，手机看到的一直是 22:28 的版本，且没有任何提示）。
 * 这里对比「正在运行的 bundle 文件名」与「服务端 index.html 现在引用的文件名」：
 * 不一致就浮出「有新版本 · 点击刷新」。
 *
 * 资源名带内容哈希（vite 产物 index-<hash>.js），所以名字不同 = 内容不同，
 * 不需要额外版本接口；index.html 在中继侧是 no-cache，取到的一定是最新的。
 */

/** 从任意 URL 中提取 vite 产物 bundle 名（如 index-IogLhVdz.js）。 */
export function bundleNameFromUrl(url: string): string | null {
  return /\/assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(url)?.[1] ?? null;
}

/** 从 index.html 文本中提取它引用的 bundle 名。 */
export function parseBundleName(html: string): string | null {
  return /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1] ?? null;
}

/** 当前运行中的 bundle 文件名（如 index-IogLhVdz.js）；开发态为 undefined。 */
export function currentBundleName(): string | null {
  return bundleNameFromUrl(import.meta.url);
}

/** 取服务端 index.html 现在引用的 bundle 文件名。 */
export async function fetchServedBundleName(): Promise<string | null> {
  try {
    // 相对 index.html 所在的同级目录——中继把 PWA 挂在根路径下。
    // （不用 import.meta.env:tsconfig 没引入 vite/client 类型，用 location 更直接）
    const base = new URL("index.html", window.location.href).href;
    const res = await fetch(`${base}?ts=${Date.now()}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseBundleName(html);
  } catch {
    return null; // 离线/中继不可达——静默跳过，不要打扰用户
  }
}

/** true = 服务端已有更新的 bundle。 */
export async function isUpdateAvailable(): Promise<boolean> {
  const current = currentBundleName();
  if (!current) return false; // 开发态（vite dev 无哈希文件名）
  const served = await fetchServedBundleName();
  return Boolean(served && served !== current);
}
