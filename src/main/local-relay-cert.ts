/**
 * 本机中继的 TLS 证书：**缺就自动生成，缺 SAN 就重签**。
 *
 * 为什么需要它（而不是让用户手填两个 PEM 路径）：
 *   · 本机中继的 https 入口服务的是「同一局域网 / 同一 tailnet 的浏览器」——这是**唯一**能让
 *     浏览器走内网快路径的方式（https 页面禁止明文 ws，PWA 的 E2E 又只在安全上下文可用）。
 *   · 手填路径的代价是：证书一过期、内网 IP 一变（DHCP）、换台机器，用户都没有 UI 可改，
 *     只能去编辑 `config.json`。实测 2026-10 就踩过“SAN 里没有当前 IP”的坑。
 *
 * 生成策略（自签，两级）：
 *   ① **机器 CA**（`local-relay-ca.crt|key`，10 年）：设备装一次根证书即可信任下面所有叶子；
 *   ② **叶子证书**（`lan-relay.crt|key`，825 天）：SAN 覆盖当前全部内网 IPv4 + tailnet IPv4 +
 *      主机名 + localhost，由 ① 签发。
 *
 * 复用规则：现有证书能解析、未过期（> 30 天）、且 SAN **覆盖当前全部地址** → 原样复用，不重签。
 * 任何一项不满足就重签叶子（CA 不动，避免设备上已装的根证书失效）。
 */
import { X509Certificate, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import selfsigned from "selfsigned";

/** 叶子证书有效期（天）。825 天 ≈ 27 个月，避开浏览器对 > 825 天的限制。 */
export const LEAF_DAYS = 825;

/** CA 有效期（天）：10 年，避免"设备装过根证书却要定期重装"。 */
export const CA_DAYS = 3650;

/** 剩余有效期低于这个值就认为该轮换（天）。 */
export const ROTATE_WINDOW_DAYS = 30;

export interface LocalRelayCertResult {
  certFile: string;
  keyFile: string;
  /** 机器 CA 证书（给设备安装一次根证书用；不含私钥）。 */
  caFile: string;
  /** 本次是否重新生成过叶子证书。 */
  generated: boolean;
  /** 人话原因（进诊断日志）。 */
  reason: string;
}

export interface EnsureLocalRelayCertInput {
  /** 落盘目录（通常是 `<userData>/relay-tls`）。 */
  dir: string;
  /** 现有配置里的证书/私钥路径（可能不存在或对不上当前地址）。 */
  certFile?: string | null;
  keyFile?: string | null;
  /** 需要覆盖的 IP 地址（内网 IPv4 + tailnet IPv4）。 */
  addresses: readonly string[];
  /** 机器名（也会进 SAN，便于用主机名访问）。 */
  hostname?: string;
  log?: (line: string) => void;
}

/** 从证书里取 SAN 里的 IP 列表（解析失败返回空数组）。 */
export function certIpAddresses(certPem: string): string[] {
  try {
    const cert = new X509Certificate(certPem);
    const san = cert.subjectAltName || "";
    return [...san.matchAll(/IP Address:\s*([0-9.]+)/g)].map((match) => match[1]);
  } catch {
    return [];
  }
}

/** 证书是否"还能用"：可解析、未过期、剩余 > ROTATE_WINDOW_DAYS、且覆盖全部地址。 */
export function certCovers(certPem: string, addresses: readonly string[], now = Date.now()): { ok: boolean; reason: string } {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return { ok: false, reason: "证书无法解析" };
  }
  const validTo = Date.parse(cert.validTo);
  if (!Number.isFinite(validTo)) return { ok: false, reason: "证书有效期读不出来" };
  const daysLeft = Math.floor((validTo - now) / 86_400_000);
  if (daysLeft <= ROTATE_WINDOW_DAYS) return { ok: false, reason: `证书 ${daysLeft} 天后过期` };
  const covered = new Set(certIpAddresses(certPem));
  const missing = addresses.filter((address) => address && !covered.has(address));
  if (missing.length) return { ok: false, reason: `证书 SAN 缺少地址 ${missing.join(", ")}` };
  return { ok: true, reason: `复用现有证书（还有 ${daysLeft} 天）` };
}

/** 读文件；失败返回 null（不抛）。 */
function readOrNull(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

/** 私钥能不能用（PEM 解析 + 与证书配对这件事交给 TLS 层，这里只挡掉明显的坏文件）。 */
function keyLooksUsable(keyPem: string | null): boolean {
  if (!keyPem) return false;
  try {
    createPrivateKey(keyPem);
    return true;
  } catch {
    return false;
  }
}

function writeIfChanged(file: string, content: string): void {
  const existing = readOrNull(file);
  if (existing === content) return;
  writeFileSync(file, content, { mode: 0o600 });
}

/**
 * 确保本机中继有一份可用的证书。**永不抛**：生成失败就返回 null，调用方按"没有 TLS 入口"处理
 * （功能退化，但不该把应用带崩）。
 */
export async function ensureLocalRelayCert(input: EnsureLocalRelayCertInput): Promise<LocalRelayCertResult | null> {
  const log = input.log ?? (() => {});
  const dir = input.dir;
  const caFile = join(dir, "local-relay-ca.crt");
  const caKeyFile = join(dir, "local-relay-ca.key");
  const certFile = join(dir, "lan-relay.crt");
  const keyFile = join(dir, "lan-relay.key");

  const addresses = [...new Set(input.addresses.map((address) => String(address || "").trim()).filter(Boolean))];
  if (!addresses.length) {
    log("local-relay-cert 跳过：没有任何可用的本机地址");
    return null;
  }

  // ① 现有配置里的证书能用就直接用它（用户手工配的也照样尊重）
  for (const candidate of [
    { cert: input.certFile || "", key: input.keyFile || "" },
    { cert: certFile, key: keyFile },
  ]) {
    if (!candidate.cert || !candidate.key) continue;
    const certPem = readOrNull(candidate.cert);
    const keyPem = readOrNull(candidate.key);
    if (!certPem || !keyLooksUsable(keyPem)) continue;
    const verdict = certCovers(certPem, addresses);
    if (verdict.ok) {
      const ca = readOrNull(caFile) ? caFile : "";
      return { certFile: candidate.cert, keyFile: candidate.key, caFile: ca, generated: false, reason: verdict.reason };
    }
    log(`local-relay-cert 需要重签：${verdict.reason}`);
  }

  // ② 生成（CA 缺或坏就重建；叶子总是重签）
  try {
    mkdirSync(dir, { recursive: true });
    let caCert = readOrNull(caFile);
    let caKey = readOrNull(caKeyFile);
    const caUsable = caCert && keyLooksUsable(caKey) && certCovers(caCert, [], Date.now()).ok;
    if (!caUsable) {
      const ca = await selfsigned.generate([{ name: "commonName", value: "MPI Local Relay CA" }], {
        keySize: 2048,
        algorithm: "sha256",
        notAfterDate: new Date(Date.now() + CA_DAYS * 86_400_000),
        extensions: [
          { name: "basicConstraints", cA: true, critical: true },
          { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
        ],
      });
      caCert = ca.cert;
      caKey = ca.private;
      writeIfChanged(caFile, ca.cert);
      writeIfChanged(caKeyFile, ca.private);
      log(`local-relay-cert 已生成本机 CA（${CA_DAYS} 天）`);
    }

    const altNames = [
      ...addresses.map((ip) => ({ type: 7 as const, ip })),
      { type: 2 as const, value: "localhost" },
      ...(input.hostname ? [{ type: 2 as const, value: String(input.hostname).trim() }] : []),
    ];
    const leaf = await selfsigned.generate([{ name: "commonName", value: addresses[0] }], {
      keySize: 2048,
      algorithm: "sha256",
      notAfterDate: new Date(Date.now() + LEAF_DAYS * 86_400_000),
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames },
      ],
      ca: { key: String(caKey), cert: String(caCert) },
    });
    writeIfChanged(certFile, leaf.cert);
    writeIfChanged(keyFile, leaf.private);
    log(`local-relay-cert 已重签叶子证书：${addresses.join(", ")}（${LEAF_DAYS} 天）`);
    return {
      certFile,
      keyFile,
      caFile,
      generated: true,
      reason: `重签完成（覆盖 ${addresses.join(", ")}）`,
    };
  } catch (error) {
    log(`local-relay-cert 生成失败：${(error as Error)?.message || error}`);
    return null;
  }
}
