/**
 * 原子文件写入 —— 「小状态文件」的统一落盘底座。
 *
 * 由来：Windows 上 `renameSync` 会**假失败**（杀软 / 搜索索引器短暂持句柄），实测约
 * 1.9% 抛 EPERM 但重命名其实已生效。原来只有知芽记忆池 `zhiya/pool.ts` 处理了这个坑，
 * 其它状态文件各写一份裸 `renameSync`（或直接覆写目标文件）。本模块把它提出来共用，
 * `json-store.ts` 与 `pool.ts` 都走这里。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 重命名函数（可注入，便于测试错误分支）。 */
export type Renamer = (tmp: string, dest: string) => void;

/** 同步小睡（本模块是同步 API，不能用 await）。 */
function sleepSync(ms: number): void {
  // Atomics.wait 在非 worker 线程上等待共享内存是允许的
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 目标文件是否已经就是我们要写的内容（用于识别 Windows 的「假失败」）。 */
function destAlreadyWritten(dest: string, content: string): boolean {
  try {
    if (!existsSync(dest)) return false;
    const st = statSync(dest);
    if (!st.isFile() || st.size !== Buffer.byteLength(content, "utf8")) return false;
    return readFileSync(dest, "utf8") === content;
  } catch {
    return false;
  }
}

/**
 * 原子替换（临时文件 → 目标），并容错 **Windows 的「假失败」**。
 *
 * 实测（2026-09-20 真机，800 次原子写）：约 **1.9%（15/800）** 的 `renameSync` 抛
 * `EPERM: operation not permitted`，**但重命名其实已经生效**——目标文件存在且内容
 * 完整（同一 id、字节数一致）。成因是杀软/搜索索引器短暂持有句柄的竞态：
 * 操作生效，错误照报。
 *
 * 为什么不能盲目重试：第二次 rename 会因目标已存在而继续报错，最终把**已经写好**的
 * 条目当失败——迁移会报「N 条失败」而实际全部成功，上层还可能触发多余的清理/回滚。
 *
 * 正确做法：出错后**先校验目标文件内容是否与待写内容一致**（内容含 id，一致即同一条），
 * 一致 → 判定成功（并清掉临时文件）；不一致 → 有限重试（退避），仍失败才抛。
 */
export function atomicReplace(tmp: string, dest: string, content: string, rename: Renamer = renameSync, attempts = 3): void {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      rename(tmp, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (destAlreadyWritten(dest, content)) {
        rmSync(tmp, { force: true });
        return;
      }
      if (i < attempts - 1) sleepSync(20 * (i + 1));
    }
  }
  rmSync(tmp, { force: true });
  throw new Error(`原子写失败（已尝试 ${attempts} 次）：${(lastErr as Error)?.message || lastErr}`);
}

/**
 * 写文本文件：先写同目录临时名，再原子替换目标。
 *
 * 失败会抛出（调用方决定吞掉还是上报）；父目录不存在时自动创建。
 * 读侧因此永远只会看到「旧文件」或「新文件」，不会看到半截内容。
 */
export function writeFileAtomic(file: string, content: string): void {
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  // 临时名带 pid：dev / prod 两个进程同时跑时不会互相覆盖对方的中间产物。
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  atomicReplace(tmp, file, content);
}
