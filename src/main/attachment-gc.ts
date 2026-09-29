/**
 * 附件 GC 的「引用集合」——**哪些附件还被会话历史引用着**。
 *
 * 为什么需要它：附件区的清理过去按 mtime 从旧到新删到 1GB 以内。但视频一旦被删，历史里那条
 * 消息就只剩一张占位卡片——用户的原话是「看不了」，而主机本来应该是**最全的备份**。
 * 现在改成：只有**没有任何会话引用**的附件才会被清理，被引用的永不自动删（超上限提示用户）。
 *
 * 实现要点：
 *   1. 扫的是**全部会话文件**（含已归档/其它项目的会话），不是只有当前打开的那条；
 *   2. 只做「引用名」的收集，读不出文件时**返回 null**（调用方据此一个都不删——宁可不腾空间）；
 *   3. 结果进程内缓存（默认 5 分钟）：GC 在启动与超限时跑，没必要每次都重扫几十 MB 的 JSONL。
 */
import { collectJsonStrings } from "./json-strings";
import { splitVideoRefs, VIDEO_REF_ATTR } from "./remote/video-refs";
import { defaultSessionsDir, forEachLine, getSessionsDir, listAllSessionFiles } from "./session-store";

export interface CollectReferencedOptions {
  /** 会话根目录；默认取用户配置（Settings → 数据管理）里的那个。 */
  sessionsRoot?: string;
  /** 绕过缓存强制重扫。 */
  force?: boolean;
}

/** 缓存有效期：附件引用变化不快，5 分钟足够，也避免 GC 每次都扫全量历史。 */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { at: number; names: Set<string> } | null = null;

/** 测试用：清掉缓存。 */
export function resetReferencedAttachmentCache(): void {
  cached = null;
}

/**
 * 收集「被会话引用过的附件名」（视频名 + 封面名）。
 *
 * @returns 名字集合；**读不到会话目录时返回 null**（调用方必须按「不可信」处理，不要当成空集合）。
 */
export async function collectReferencedAttachmentNames(options: CollectReferencedOptions = {}): Promise<Set<string> | null> {
  if (!options.force && !options.sessionsRoot && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.names;

  let root: string;
  try {
    root = options.sessionsRoot || getSessionsDir();
  } catch {
    // 读配置失败（自定义会话目录要读 config）→ 回退到 pi 默认位置；连这个都拿不到才放弃。
    try {
      root = defaultSessionsDir();
    } catch {
      return null;
    }
  }
  const files = listAllSessionFiles(root);
  const names = new Set<string>();
  try {
    for (const file of files) {
      await forEachLine(file, (line) => {
        // 快速过滤：JSONL 里引用是**转义过的**（`attach=\"video\"`），所以只匹配属性名，
        // 真正的判定交给 splitVideoRefs（它拿到的是解析后的字符串）。
        if (!line.includes("attach=")) return;
        for (const text of collectJsonStrings(line)) {
          if (!text.includes(VIDEO_REF_ATTR)) continue;
          for (const ref of splitVideoRefs(text).refs) {
            if (ref.name) names.add(ref.name);
            if (ref.poster) names.add(ref.poster);
          }
        }
      });
    }
  } catch {
    // 读会话文件失败（权限/半截写入/目录消失）：**不返回部分结果**——部分结果会让 GC 删掉
    // 那些其实还被引用的附件。
    return null;
  }
  if (!options.sessionsRoot) cached = { at: Date.now(), names };
  return names;
}
