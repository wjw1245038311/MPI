/**
 * 内置服务器的 TLS 信任链（自签 CA 固定）。
 *
 * 为什么需要：ECS 中继的 9443 用的是**自签证书**（`CN=47.97.28.110`，CA 是我们自己的
 * `MPI Self-signed CA`，SAN 覆盖 `47.97.28.110` / `100.67.5.31` / `aliyun-ecs.tail38d5a.ts.net`）。
 * Node 默认拒绝这条链（`self-signed certificate in certificate chain`），于是主机上行一直连不上
 * ——2026-10-16 实测：dev 实例 `uplinks=builtin,local` 但 ECS 那条从未注册成功，手机只能靠 CF 隧道兜底。
 *
 * 修法不是关掉校验（`rejectUnauthorized: false` 会把 TLS 变成摆设），而是**把我们的 CA 固定下来**：
 * 证书随应用分发（公共证书，不含私钥），握手时作为 `ca` 传给 WS 客户端。
 * 地址仍按内置描述里的候选顺序走（tailnet TLS → 公网明文兜底）。
 *
 * 只在主进程用（读文件 + 路径解析）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 打包后在 `resources/` 根下，开发时在仓库的 `resources/` 里。 */
export function resolveRelayCaPath(args: { isPackaged: boolean; resourcesPath: string; appPath: string }): string | null {
  const packaged = join(args.resourcesPath, "mpi-relay-ca.crt");
  if (args.isPackaged) return existsSync(packaged) ? packaged : null;
  const dev = join(args.appPath, "resources", "mpi-relay-ca.crt");
  return existsSync(dev) ? dev : null;
}

let cached: string[] | null = null;

/**
 * CA 证书内容（PEM 数组）。读不到就返回空数组 —— 那就退回 Node 默认信任链，
 * wss 候选会失败、自动落到明文候选（不阻塞任何功能，只是少了那层 TLS）。
 */
export function relayCaPem(args: { isPackaged: boolean; resourcesPath: string; appPath: string }): string[] {
  if (cached) return cached;
  const file = resolveRelayCaPath(args);
  if (!file) return [];
  try {
    cached = [readFileSync(file, "utf8")];
  } catch {
    cached = [];
  }
  return cached;
}

/** 测试/重启用：清掉缓存。 */
export function clearRelayCaCache(): void {
  cached = null;
}
