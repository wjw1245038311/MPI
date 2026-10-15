/**
 * 「agent → 客户端」附件下行的**纯逻辑核心**（无 electron / 无 fs 写入）。
 *
 * 为什么单独一个文件：路径白名单、限额、请求校验这些判定既要被主进程 ingest 用，
 * 也要被 pi 扩展（mpi-attach-file-ext.ts，以 ?raw 内联后由 pi 的 TS loader 执行，
 * 拿不到 electron 模块）用；同时它们是本功能唯一的安全边界，必须能脱离应用单测。
 *
 * 威胁模型（务必读）：这条边界是**给用户的知情确认**，不是防恶意 agent 的沙箱。
 * 同一个会话里的 bash 本来就能读任意文件并联网外发，真要防外带靠的是 permission-gate
 * 与 trustedTools，而不是这里。所以本模块只做两件事：① 让常见路径零打扰直发；
 * ② 让越界路径必须经用户点一次头，且没有 UI 时一律拒绝。
 */
import { extname } from "node:path";

/**
 * 单件上限（决策 2026-10-15：与视频同一档 128MB）。
 *
 * 对象库总量另有 `chat-attachment-store` 的 MAX_DIR_BYTES（1GB）兜底，GC 按引用感知回收。
 */
export const ATTACH_FILE_MAX_BYTES = 128 * 1024 * 1024;

/** 引用里 kind 固定为 file（媒体族里的「其它」，客户端画通用文件卡片）。 */
export const ATTACH_FILE_KIND = "file" as const;

/** 允许的请求字段（多余字段忽略，缺 id/path/cwd 直接拒）。 */
export interface AttachFileRequest {
  id: string;
  /** agent 传入的原始路径（可能相对 cwd、可能是 Git Bash 的 /e/... 形式） */
  path: string;
  cwd: string;
  /** 展示名（缺省用 basename） */
  label?: string;
  /** 给用户看的一句话说明，出现在回执与卡片上 */
  note?: string;
  /** 本会话 session JSONL，仅用于诊断（不参与判定） */
  sessionFile?: string;
  /**
   * 用户在扩展的审批卡上点过「允许」（仅白名单外需要）。
   *
   * 这是知情确认凭证，不是密码学凭证——见文件头的威胁模型。
   */
  approved?: boolean;
}

export interface AttachFileVerdict {
  ok: boolean;
  /** 拒绝原因（面向 agent 的英文说明，模型会照着改做法） */
  error?: string;
  /** 是否属于白名单外（调用方据此决定是否弹审批卡） */
  outsideRoots?: boolean;
  /** 归一化后的绝对路径（Windows 形式，E:/…） */
  abs?: string;
  /** 展示名 */
  label?: string;
  size?: number;
}

const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;
const UNC_ABS = /^\\\\/;
/** Git Bash / MSYS 风格：/e/a/b → E:/a/b（本会话唯一 shell 是 Git Bash，agent 常这么写）。 */
const MSYS_ABS = /^\/([a-zA-Z])\/(.+)$/;

/** 归一化 + 去 `..`/`.`，输出统一用正斜杠；不碰磁盘。 */
export function normalizePath(value: string): string {
  const slash = String(value || "").trim().replace(/\\/g, "/");
  const drive = slash.match(/^([a-zA-Z]:)/)?.[1] || "";
  const body = drive ? slash.slice(drive.length) : slash;
  const rooted = !!drive || body.startsWith("/");
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!rooted) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const prefix = drive ? `${drive}/` : rooted ? "/" : "";
  return prefix + parts.join("/");
}

/** 把 agent 给的路径变成绝对 Windows 形式（相对路径按 cwd 解析）。 */
export function resolveAgentPath(raw: string, cwd: string): string {
  const rawTrimmed = String(raw || "").trim().replace(/^["']+|["']+$/g, "");
  const msys = rawTrimmed.match(MSYS_ABS);
  if (msys) return normalizePath(`${msys[1].toUpperCase()}:/${msys[2]}`);
  if (WINDOWS_ABS.test(rawTrimmed) || UNC_ABS.test(rawTrimmed) || rawTrimmed.startsWith("/")) {
    return normalizePath(rawTrimmed);
  }
  return normalizePath(`${cwd.replace(/\\/g, "/")}/${rawTrimmed}`);
}

/**
 * 免审批根目录（决策：限工作区 + tempfile + Share，越界审批）。
 *
 * - 会话 cwd：agent 正在做的项目，产物发出去是主场景。
 * - `<workspace>/Work/tempfile`：会话临时产物的既定落点。
 * - `<workspace>/Share`：跨设备交换区，本来就是「要传出去」的语义。
 *
 * workspace 根优先取 env `MPI_WORKSPACE_ROOT`（各设备布局不同，见 WorkspaceLayout.md），
 * 没有就从 cwd 向上找一个名为 MyWorkspace 的祖先；都找不到就只剩 cwd —— 宁可少放行，
 * 也不要因为推错根目录把整块盘变成白名单。
 */
export function allowedRoots(cwd: string, workspaceRoot?: string): string[] {
  const roots = [normalizePath(cwd)];
  const root = findWorkspaceRoot(cwd, workspaceRoot);
  if (root) {
    roots.push(normalizePath(`${root}/Work/tempfile`));
    roots.push(normalizePath(`${root}/Share`));
  }
  return [...new Set(roots.filter(Boolean))];
}

/** 找 workspace 根：显式配置 > 向上找 MyWorkspace > null。 */
export function findWorkspaceRoot(cwd: string, configured?: string): string | null {
  const explicit = String(configured || "").trim();
  if (explicit) return normalizePath(explicit);
  const parts = normalizePath(cwd).split("/");
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].toLowerCase() === "myworkspace") return normalizePath(parts.slice(0, i + 1).join("/"));
  }
  return null;
}

/** path 是否落在任一 root 内（含 root 自身）。大小写不敏感（Windows）。 */
export function isWithinRoots(path: string, roots: string[]): boolean {
  const target = normalizePath(path).toLowerCase().replace(/\/+$/, "");
  for (const raw of roots) {
    const root = normalizePath(raw).toLowerCase().replace(/\/+$/, "");
    if (!root) continue;
    if (target === root || target.startsWith(`${root}/`)) return true;
  }
  return false;
}

/** 常见扩展名 → mime；认不出给 octet-stream（客户端据此显示通用图标，不猜错类型）。 */
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".msi": "application/x-msdownload",
  ".apk": "application/vnd.android.package-archive",
};

export function guessMimeType(path: string, fallbackLabel?: string): string {
  const fromName = MIME_BY_EXT[extname(path).toLowerCase()];
  if (fromName) return fromName;
  const fromLabel = fallbackLabel ? MIME_BY_EXT[extname(fallbackLabel).toLowerCase()] : undefined;
  return fromLabel || "application/octet-stream";
}

/** 文件名安全化（与 `materializeIntoWorkspace` 同一思路：Windows 非法字符换 `-`）。 */
export function safeLabel(name: string): string {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .trim()
    .slice(0, 180);
  return cleaned || "附件";
}

const basename = (path: string): string => normalizePath(path).split("/").filter(Boolean).pop() || path;

/**
 * 校验一次附件事务的**请求侧**条件（不碰对象库，主进程 ingest 前还要复核磁盘状态）。
 *
 * @param requireInsideRoots true = 白名单外直接拒（ingest 用，扩展已弹过卡则传 false）
 */
export function checkAttachRequest(req: AttachFileRequest, opts: { requireInsideRoots?: boolean; workspaceRoot?: string } = {}): AttachFileVerdict {
  const rawPath = String(req?.path || "").trim();
  const cwd = String(req?.cwd || "").trim();
  if (!req?.id || !rawPath || !cwd) {
    return { ok: false, error: "attach request is missing id, path or cwd." };
  }
  const abs = resolveAgentPath(rawPath, cwd);
  const label = safeLabel(String(req.label || "").trim() || basename(abs));
  const roots = allowedRoots(cwd, opts.workspaceRoot);
  const inside = isWithinRoots(abs, roots);
  if (!inside && opts.requireInsideRoots) {
    return {
      ok: false,
      outsideRoots: true,
      abs,
      label,
      error: `"${abs}" is outside this session's workspace (allowed: project dir, Work/tempfile, Share). Ask the user to approve it explicitly.`,
    };
  }
  return { ok: true, abs, label, ...(inside ? {} : { outsideRoots: true }) };
}

/** 回执：主进程写完对象库后回给扩展的内容。 */
export interface AttachFileReceipt {
  id: string;
  ok: boolean;
  /** 成功时给 agent 的完整引用文本（原样贴进回复正文即可） */
  text?: string;
  error?: string;
  size?: number;
  key?: string;
}
