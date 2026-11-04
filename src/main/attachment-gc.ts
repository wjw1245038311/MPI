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
import { MEDIA_REF_ATTR, splitVideoRefs, VIDEO_REF_ATTR } from "./remote/video-refs";
import { defaultSessionsDir, forEachLine, getSessionsDir, listAllSessionFiles } from "./session-store";

export interface CollectReferencedOptions {
  /** 会话根目录；默认取用户配置（Settings → 数据管理）里的那个。 */
  sessionsRoot?: string;
  /** 绕过缓存强制重扫。 */
  force?: boolean;
}

/**
 * 从一段文本里收集 `mpi_attachment` 元数据里的对象名（`mpi_attach_file` 的**唯一**引用痕迹）。
 *
 * 为什么必须单独收集：这一类附件不写 `<file … attach="…" />`，只在工具回执里留一行
 * `{"mpi_attachment":{"name":"<hex>",…}}`（见 mpi-attach-file-ext.ts）。以前 live-set
 * 只认 attach 属性，于是没人认它们——对象区一超 1GB，GC 就把它们当垃圾删了，历史里
 * 只剩一张点不开的卡片（用户感知：「附件已不可用」）。
 *
 * 名字长度放宽到 8–128：内容寻址是 64 位 hex，老名字可能带后缀（`<hash>.docx`）。
 */
export function attachMetaNames(text: string): string[] {
  if (!text || !text.includes("mpi_attachment")) return [];
  const names: string[] = [];
  for (const match of text.matchAll(META_NAME_RE)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

const META_NAME_RE = /"mpi_attachment"\s*:\s*\{[^{}]*?"name"\s*:\s*"([A-Za-z0-9._-]{8,128})"/g;

/** 缓存有效期：附件引用变化不快，5 分钟足够，也避免 GC 每次都扫全量历史。 */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { at: number; names: Set<string> } | null = null;

/** 测试用：清掉缓存。 */
export function resetReferencedAttachmentCache(): void {
  cached = null;
}

/**
 * 收集「被会话引用过的附件名」（媒体引用的 name + 缩略图名）。
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
        // `mpi_attachment` 也要放行：那是 agent 递交附件留下的一行 JSON（无 attach 属性）。
        if (!line.includes("attach=") && !line.includes("mpi_attachment")) return;
        for (const text of collectJsonStrings(line)) {
          // `mpi_attach_file` 的对象名（agent → 会话）也要算引用，否则超容量时会被当成
          // 「没人用」删掉，历史里只剩一张点不开的卡片。
          for (const name of attachMetaNames(text)) names.add(name);
          // 两种标记都要认：attach="video"（视频/存量）与 attach="media"（P3 的图/音/文件，
          // 含桌面拖入的普通文件与 agent 的 mpi_attach_file）。只判 video 会让这些对象
          // 不在 live-set 里 —— 附件区一超 1GB 就会被当成「没人引用」删掉，点开即「已不可用」。
          if (!text.includes(VIDEO_REF_ATTR) && !text.includes(MEDIA_REF_ATTR)) continue;
          for (const ref of splitVideoRefs(text).refs) {
            if (ref.name) names.add(ref.name);
            if (ref.thumb) names.add(ref.thumb);
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
