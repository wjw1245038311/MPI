/**
 * 记忆池服务（主进程侧单例）——把「用哪个索引」「池目录在哪」收敛到一处。
 *
 * 索引选择：优先 zvec（可重排的候选生成 + 语义召回），失败则退到 JsonIndex。
 * ⚠️ zvec 是原生模块（N-API）；dev 下从 node_modules 直接加载，打包版需要
 *    electron-builder 的 asarUnpack（见 IMPL-PLAN §1「不需要」一节的备注）。
 *    进程内只创建一次；任何失败都退到 JsonIndex，绝不让记忆功能拖垮应用。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JsonIndex, defaultPoolDir, type MemoryIndex } from "./zhiya/memory-index";
import { ZvecIndex } from "./zhiya/zvec-index";

/** 索引目录占用统计（压缩决策用）。 */
interface DirStats {
  bytes: number;
  segments: number;
}

function dirStats(root: string): DirStats {
  let bytes = 0;
  let segments = 0;
  const walk = (dir: string): void => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = join(dir, it.name);
      try {
        if (it.isDirectory()) walk(p);
        else {
          bytes += statSync(p).size;
          if (it.name.includes(".proxima")) segments++;
        }
      } catch {
        /* 读不到就不算 */
      }
    }
  };
  walk(root);
  return { bytes, segments };
}

/** 压缩阈值：>32MB 或 段文件 >8 个。两者都远超正常值（16 条 → 4.6MB / 1 段）。 */
export const COMPACT_LIMITS = { bytes: 32 * 1024 * 1024, segments: 8 };

export function shouldCompactFromStats(st: DirStats): boolean {
  return st.bytes > COMPACT_LIMITS.bytes || st.segments > COMPACT_LIMITS.segments;
}

/** 按目录直接判断是否该压缩（退出路径用，不依赖索引句柄）。 */
export function shouldCompact(root: string): boolean {
  return shouldCompactFromStats(dirStats(root));
}

let indexPromise: Promise<MemoryIndex> | null = null;
let usedKind: "zvec" | "json" | null = null;

export function memoryPoolDir(): string {
  return defaultPoolDir();
}

/** 索引类型（诊断/日志用）。 */
export function memoryIndexKind(): "zvec" | "json" | null {
  return usedKind;
}

/** 懒加载索引单例。 */
export function getMemoryIndex(): Promise<MemoryIndex> {
  if (!indexPromise) {
    const poolDir = memoryPoolDir();
    indexPromise = (async () => {
      try {
        const idx = await ZvecIndex.open(poolDir);
        usedKind = "zvec";
        return idx;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[memory] zvec 不可用，退到 JsonIndex：", (e as Error).message);
        usedKind = "json";
        return new JsonIndex(poolDir);
      }
    })();
  }
  return indexPromise;
}

/** 释放（应用退出时调用；zvec 无常驻句柄，主要是清缓存与句柄）。 */
export async function disposeMemoryIndex(): Promise<void> {
  const p = indexPromise;
  indexPromise = null;
  if (!p) return;
  try {
    const idx = await p;
    // 退出前顺手压一次：zvec 不会自动合并段文件，不压就一天涨 100MB
    if (usedKind === "zvec" && shouldCompact(memoryPoolDir())) {
      await idx.compact().catch(() => {});
    }
    await idx.close();
  } catch {
    /* 退出路径，尽力而为 */
  }
}

/**
 * 启动后的一次性维护：索引磁盘膨胀到阈值就压缩。
 * 为什么必须做：zvec 每次写入落一个 5MB 段文件，**不会自动合并**——
 * 实测跑一天 16 条条目就攒到 124MB，`optimizeSync()` 后回到 4.6MB。
 * 放后台异步做，失败不影响任何功能（索引是派生数据）。
 */
export function scheduleMemoryMaintenance(log: (m: string) => void = () => {}): void {
  void (async () => {
    try {
      const idx = await getMemoryIndex();
      if (usedKind !== "zvec") return;
      const root = `${memoryPoolDir()}/.zvec`;
      const st = dirStats(root);
      if (!shouldCompactFromStats(st)) return;
      log(`[memory] 索引膨胀（${(st.bytes / 1048576).toFixed(0)}MB / ${st.segments} 段）→ 压缩`);
      const t0 = Date.now();
      await idx.compact();
      const after = dirStats(root);
      log(
        `[memory] 压缩完成：${(st.bytes / 1048576).toFixed(0)}MB → ${(after.bytes / 1048576).toFixed(0)}MB（${Date.now() - t0}ms）`,
      );
    } catch (e) {
      log(`[memory] 压缩失败（不影响功能）：${(e as Error).message}`);
    }
  })();
}
