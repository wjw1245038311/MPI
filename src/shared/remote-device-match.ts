/**
 * 「同一台设备」的识别规则（纯逻辑，便于 L1 测试）。
 *
 * 背景：手机端每换一个网址 origin（中继 https / LAN http / 公网明文 http）就是另一套
 * IndexedDB，于是生成**全新设备身份**，主机侧就多一条记录——而名字都叫「MPI PWA」，
 * 用户看到一排一模一样的条目（百度云那类软件会按设备收敛成一条）。
 *
 * 识别优先级：
 *   ① deviceId：`device-<sha256(公钥 PEM)[:24]>`，公钥派生，理论上已唯一；
 *   ② publicKeyPem：派生规则将来若变化，同一把公钥也不该出现两行（兜底）；
 *   ③ 同名 + 离线：**只能是启发式**——网页端换了 origin 就是新公钥，没有密码学证据证明
 *      「这是同一台手机」，所以只按「名字完全相同且旧记录已离线」判定，并且调用方要允许
 *      关掉（设置项）。同一 WiFi 下两台同名设备会被误判，所以 PWA 侧的名字里带 4 位短号
 *      （见 mobile/pwa/src/lib/device-name.ts）来把同名概率压到很低。
 */

export interface TrustedDeviceLike {
  deviceId: string;
  name: string;
  publicKeyPem: string;
  addedAt: number;
  lastSeenAt?: number;
}

/** ① deviceId 命中 → ② 公钥命中；都没有 = 新设备。 */
export function findTrustedDevice<T extends TrustedDeviceLike>(
  devices: readonly T[],
  deviceId: string,
  publicKeyPem: string,
): T | undefined {
  return devices.find((d) => d.deviceId === deviceId) ?? devices.find((d) => d.publicKeyPem === publicKeyPem);
}

/**
 * 挑出「应被新设备替换掉」的同名离线记录（无则 null）。
 *
 * - 名字为空不参与（避免把用户自起的名字跟空名字混为一谈）；
 * - 只挑**离线**的（有活跃连接说明它正在用，替换会把人家踢掉）；
 * - 同名有多条时只收敛**最久没露面**的那一条——一次配对只换一条，避免误伤扩散。
 */
export function pickSameNameOfflineReplacement<T extends TrustedDeviceLike>(
  devices: readonly T[],
  name: string,
  isOnline: (deviceId: string) => boolean,
): T | null {
  const target = String(name || "").trim();
  if (!target) return null;
  const candidates = devices.filter((d) => d.name === target && !isOnline(d.deviceId));
  if (!candidates.length) return null;
  return candidates.reduce((oldest, d) =>
    (d.lastSeenAt ?? d.addedAt) < (oldest.lastSeenAt ?? oldest.addedAt) ? d : oldest,
  );
}

/** 设备短号（面板里区分同名设备用）：`device-85pUtRIs…` → `85pUt`。 */
export function shortDeviceId(deviceId: string, length = 5): string {
  const body = String(deviceId || "").replace(/^device-/, "");
  return body ? body.slice(0, length) : "?";
}
