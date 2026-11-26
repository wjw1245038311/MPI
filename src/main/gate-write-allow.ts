import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 定时任务的「可写路径白名单」。
 *
 * 背景（minibox 2026-11-26 邮件第 4 条）：无人值守任务要覆盖项目外的台账时，
 * 只能把整个任务设成 full 权限；它要求改成「任务级可写路径白名单，越界只拦那
 * 一次操作，不整任务失败」。
 *
 * === 关于这个设计的风险（记录在案） ===
 * 白名单等于给无人值守任务一条**持久的**绕过门禁通道：agent 只要诱导用户建一个
 * 白名单较宽的任务，之后每次运行都带着这份授权，而用户在面板上很难审计。这与
 * 「无人值守时无法授权所以保守」的原始信任模型相反。用户拍板要做，因此实现时做了
 * 三层收敛把损失压到最小：
 *
 *   1. **HARD_RISK 不可豁免**：磁盘格式化、仓库发布/重写、提权等判定在门禁里排在
 *      白名单之前，白名单永远救不了它们。
 *   2. **只豁免「写目标越界」这一类判定**：不豁免网络请求、命令替换、敏感路径、
 *      无法解析的引号等。白名单只能回答「这个路径可以写」，不能回答「这个命令安全」。
 *   3. **越界只拦那一次操作**：门禁拒绝该次工具调用，任务继续执行并可记成功；
 *      被拦的记录写进运行历史，面板可见。
 *
 * 约束（代码强制）：
 *   - 只接受 cwd 内的相对 glob，或显式的绝对路径；`~`、`..` 越界一律拒绝。
 *   - 敏感路径（.git、.env、密钥、系统目录）即使在白名单里也拒绝。
 *   - 条数上限 50，单条长度上限 300。
 *   - 白名单文件与 mode 文件分开存放：权限位与写范围是两件事，混读会让
 *     「切到 full」意外带上旧白名单。
 */

export const MAX_WRITE_ALLOW_ENTRIES = 50;
const MAX_ENTRY_LENGTH = 300;

/** 无论白名单怎么写都不放行的路径特征。与门禁扩展的敏感判定保持一致。 */
const ALWAYS_DENY = [
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.env(\..*)?$/i,
  /(^|[\\/])(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/i,
  /\.(pem|pfx|p12|key|keystore)$/i,
  /(^|[\\/])(credentials|secrets?)(\.[a-z0-9]+)?$/i,
  /^[a-z]:[\\/](windows|program files|program files \(x86\)|programdata)([\\/]|$)/i,
  /(^|[\\/])system32([\\/]|$)/i,
];

export interface WriteAllowFile {
  version: 1;
  /** 允许写入的路径模式（glob）。 */
  patterns: string[];
  /** 该白名单所属任务（便于审计；运行时不用它做判定）。 */
  taskId?: string;
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function isAlwaysDenied(pattern: string): boolean {
  const p = normalizeSlashes(pattern);
  return ALWAYS_DENY.some((re) => re.test(p));
}

/**
 * 规整一条白名单条目；非法返回 null。
 *
 * 只允许两类：cwd 内的相对路径（可含 glob），或显式绝对路径。
 * 拒绝 `..` 逃逸、`~` 展开（那是 shell 行为，门禁无法预判落点）。
 */
export function sanitizeWriteAllowEntry(entry: unknown, cwd: string): string | null {
  if (typeof entry !== "string") return null;
  const raw = entry.trim();
  if (!raw || raw.length > MAX_ENTRY_LENGTH) return null;

  // normalizeSlashes 之后再做判定，避免 `a\..\b` 绕过
  const path = normalizeSlashes(raw);
  if (path.includes("\0")) return null;
  if (/^~(\/|$)/.test(path)) return null;
  if (isAlwaysDenied(path)) return null;

  if (isAbsolute(path) || /^[a-z]:\//i.test(path)) {
    // 绝对路径：不允许 `..` 段（避免 `C:/a/../../b` 这类伪装）
    if (path.split("/").some((seg) => seg === "..")) return null;
    return path;
  }

  // 相对路径：不允许上跳
  if (path.split("/").some((seg) => seg === "..")) return null;
  return path;
}

/** 批量规整（去重、截断）。 */
export function sanitizeWriteAllowList(entries: unknown, cwd: string): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const clean = sanitizeWriteAllowEntry(entry, cwd);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_WRITE_ALLOW_ENTRIES) break;
  }
  return out;
}

/**
 * 把 glob 模式转成正则。支持 `*`（单段任意）、`**`（跨段）、`?`（单字符）。
 *
 * 自己实现而不是引入依赖：白名单的匹配语义必须是「可审计的一小段代码」，
 * 引一个 glob 库意味着它的边界行为（比如 `**` 是否匹配零段）变成安全属性。
 */
export function globToRegExp(pattern: string): RegExp {
  const p = normalizeSlashes(pattern);
  let out = "^";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        // `**` 匹配任意层（含零层）
        out += ".*";
        i++;
        // 吃掉紧跟的 `/`，让 `a/**` 也能匹配 `a/` 本身
        if (p[i + 1] === "/") i++;
      } else {
        // 单段 `*`：不跨 `/`
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  out += "$";
  try {
    // 大小写不敏感：Windows 与多数文件系统如此；宁宽勿窄，但敏感路径已在上游拦掉。
    return new RegExp(out, "i");
  } catch {
    // 构建失败的模式视为「匹配一切」是危险的，改为永不匹配。
    return /(?!)/;
  }
}

/** 某个绝对路径是否命中白名单里的任一模式。 */
export function pathIsAllowed(target: string, patterns: readonly string[], cwd: string): boolean {
  if (!target || !patterns.length) return false;
  const absTarget = normalizeSlashes(resolve(target));
  if (isAlwaysDenied(absTarget)) return false;

  const absCwd = normalizeSlashes(resolve(cwd));
  for (const pattern of patterns) {
    // 绝对模式：直接对绝对路径匹配
    if (isAbsolute(pattern) || /^[a-z]:\//i.test(pattern)) {
      const absPattern = normalizeSlashes(resolve(pattern));
      if (globToRegExp(absPattern).test(absTarget)) return true;
      continue;
    }
    // 相对模式：拼到 cwd 上再匹配
    const joined = normalizeSlashes(join(absCwd, pattern));
    if (globToRegExp(joined).test(absTarget)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------------ *
 * 文件读写（sidecar）
 * ------------------------------------------------------------------------ */

function allowDir(userDataDir: string): string {
  const dir = join(userDataDir, "mpi-gate-write-allow");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 写一份任务的可写白名单文件，返回路径（供 pi 进程通过环境变量读取）。
 *
 * 放在独立目录而不是 mode 文件里：权限位与写范围是两件事，混读会让
 * 「切到 full 权限」意外带上旧白名单。
 */
export function createWriteAllowFile(userDataDir: string, taskId: string, patterns: readonly string[]): string {
  const file = join(allowDir(userDataDir), `${randomUUID()}.allow`);
  const payload: WriteAllowFile = {
    version: 1,
    patterns: [...patterns],
    ...(taskId ? { taskId } : {}),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

export function removeWriteAllowFile(file: string | null): void {
  if (!file) return;
  try {
    unlinkSync(file);
  } catch {
    /* 已删除 */
  }
}

/** 读取白名单文件（测试与诊断用；扩展侧有它自己的读取实现）。 */
export function readWriteAllowFile(file: string): WriteAllowFile | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const patterns = Array.isArray(obj.patterns)
      ? obj.patterns.filter((p): p is string => typeof p === "string")
      : [];
    return {
      version: 1,
      patterns,
      ...(typeof obj.taskId === "string" ? { taskId: obj.taskId } : {}),
    };
  } catch {
    return null;
  }
}
