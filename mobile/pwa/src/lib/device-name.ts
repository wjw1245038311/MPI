/**
 * PWA 的设备名（纯函数：拿 UA 字符串算，便于 L1 测试）。
 *
 * 为什么不能一直叫「MPI PWA」：网页端的设备身份存在**该 origin 的 IndexedDB** 里，换个地址
 * 打开就是新身份；名字又全都一样，主机侧的「已信任设备」会堆一排无法分辨的条目。所以名字里
 * 带上「系统/浏览器」+ 设备短号（deviceId 派生于公钥，短号用于区分同名设备）。
 *
 * 例：`MPI PWA · Android/Chrome · 85pU`
 */

/** 设备短号：与 src/shared/remote-device-match.ts 的 shortDeviceId 同规则。 */
export function shortDeviceLabel(deviceId: string): string {
  const body = String(deviceId || "").replace(/^device-/, "");
  return body ? body.slice(0, 4) : "????";
}

/** 系统/浏览器标签；识别不出时给 "Browser" 而不是留空。 */
export function platformLabel(userAgent: string): string {
  const ua = String(userAgent || "");
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "";
  const browser = /Edg[A-Z]?\//i.test(ua)
    ? "Edge"
    : /SamsungBrowser\//i.test(ua)
      ? "Samsung"
      : /Firefox\//i.test(ua)
        ? "Firefox"
        : /Chrome\//i.test(ua)
          ? "Chrome"
          : /Safari\//i.test(ua)
            ? "Safari"
            : "";
  const parts = [os, browser].filter(Boolean);
  return parts.length ? parts.join("/") : "Browser";
}

/** 默认设备名。 */
export function defaultDeviceName(userAgent: string, deviceId: string): string {
  return `MPI PWA · ${platformLabel(userAgent)} · ${shortDeviceLabel(deviceId)}`;
}

/** 旧版本写死的历史名字（需要在启动时迁移成 defaultDeviceName）。 */
export const LEGACY_DEVICE_NAME = "MPI PWA";
