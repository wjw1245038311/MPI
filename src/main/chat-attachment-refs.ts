/**
 * 桌面端**拖入 / 选中的普通文件** → 给模型的引用文案（纯逻辑，可脱离 electron 单测）。
 *
 * 背景（2026-11-04 反馈）：桌面端发的普通文件（pdf / xlsx / zip / docx…）在手机端
 * 只剩一行 `<file path="C:\…" />` 文本，而且路径被脱敏成 `[path]` —— 手机上根本
 * 拿不到本体，也没法下载。根因在主机的 `processAttachments`：只有图片和视频会转成
 * 块，其余走的是**不带 `attach=` 的裸引用**，快照不为它生成块（见 ipc.ts 的
 * remoteMessages）。
 *
 * 现在的规则（与 agent 递交的 `mpi_attach_file` 完全同一条路）：
 *
 *   - 图片 / 视频 / 音频 / 其它二进制或大文件 → 先入内容寻址对象库，再发
 *     `attach="media"` 引用 → 三端都有卡片（桌面卡片、安卓 📄 卡、PWA 下载卡）；
 *   - **纯文本小文件**（≤500KB 的 .md/.txt/.json…）仍然内联全文、不发引用 —— 内容是
 *     给 agent 读的，再叠一张卡片反而重复（用户 2026-11-04 决定）。
 *
 * 为什么单独成文件：这段判定既要在主进程用，也要能纯 node 单测。ipc.ts 拖了整条
 * Electron 依赖链，导入即需要 app 实例。
 */
import { mediaKindForMime, mediaMimeForPath, mediaRefEnvelope, videoMimeForPath } from "./remote/video-refs";

/** 文本类附件的内联上限（与 ipc.ts 里历史上的 500KB 一致）。 */
export const DESKTOP_INLINE_TEXT_MAX_BYTES = 500 * 1024;

/** 文件本身可读的元信息（调用方 stat + 推 mime，不在本模块碰 fs）。 */
export interface DesktopFileMeta {
  /** 真实落盘路径（给 agent 读的那份，可能是原文件） */
  abs: string;
  /** 界面展示用的可读名（通常是原文件名） */
  label: string;
  /** 字节数 */
  size: number;
  /** 粗推的 mime（`guessMimeType` 同类实现；缺省 `application/octet-stream`） */
  mime: string;
}

/** 对象库入库函数的形状（真实实现是 chat-attachment-store 的 storeObject）。 */
export type StoreObjectFn = (args: { sourcePath: string; label: string; mime: string }) => { name: string; abs: string; size: number } | null;

/**
 * 「拿去向模型递交什么」的判定结果。
 *
 * - `inline`：整段内联进提示（纯文本小文件）
 * - `plain`：不成块、只报路径（入库失败时的兜底——不静默丢消息，但至少 agent 能读）
 * - `ref`：媒体引用（三端可渲染卡片 / 播放器）
 */
export type DesktopFilePlan =
  | { kind: "inline" }
  | { kind: "plain"; reason: string }
  | { kind: "ref"; name: string; abs: string; size: number; key?: string; mediaKind: "image" | "audio" | "video" | "file" };

/**
 * 纯文本小文件要不要内联（这一类**故意**不出卡片，见文件头）。
 *
 * `ext === ""` 也算文本：没有扩展名的东西最可能是脚本 / 无后缀文本，内联比给一张
 * 打不开的卡片有用（历史行为保持）。
 */
export function shouldInlineDesktopText(size: number, isTextExt: boolean): boolean {
  return isTextExt && size <= DESKTOP_INLINE_TEXT_MAX_BYTES;
}

/** 引用里的 `key` 属性：内容寻址对象才带（老名字不带，历史消息永不重写）。 */
export function sha256RefKey(name: string): string | undefined {
  // 内容寻址的名字就是 64 位小写十六进制（与 chat-attachment-store 的 isContentKey 同口径）。
  return /^[a-f0-9]{64}$/.test(name) ? `sha256:${name}` : undefined;
}

/**
 * 把一个**已入库**的对象变成给模型的引用文案。
 *
 * `mediaKind` 由调用方按 mime 推（`mediaKindForMime`）：视频仍写旧的 `attach="video"`
 * 形式（存量客户端兼容），图/音/文件写 `attach="media" kind=…`——两种写法三端都认。
 */
export function desktopFileRefEnvelope(entry: {
  name: string;
  abs: string;
  size: number;
  label: string;
  mediaKind: "image" | "audio" | "video" | "file";
}): string {
  const key = sha256RefKey(entry.name);
  return mediaRefEnvelope({
    name: entry.name,
    abs: entry.abs,
    kind: entry.mediaKind,
    ...(key ? { key } : {}),
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.size > 0 ? { size: entry.size } : {}),
  });
}

/**
 * `mpi_attach_file` 递交的附件 → 快照块的**类型与 mime**（纯函数，可单测）。
 *
 * 为什么要跟用户自己发文件用同一套分发（2026-11-04）：attach_file 曾经无差别地生成
 * `file` 块，于是 agent 递过来的 mp4 在手机上是一张「文件卡片」（只能下载、用系统播放器
 * 打开），而同一条会话里用户自己拖入的视频却是内联播放器。两套观感差别很刺眼，而差异
 * 纯粹来自块类型——`video` 块本来就支持「快照只给名字、点开按需拉本体」（见安卓
 * VideoBlock / PWA 的省略块逻辑），所以这里只需要把 kind 分发接上，不用新协议。
 *
 * `application/octet-stream` 当「不知道是什么」处理（同 mediaExtForMime）：
 * 用文件名推大类，否则 agent 递交的 mp4 会因 mime 不准而退回文件卡片。
 */
export function attachBlockPlan(
  meta: { label?: string; name?: string },
  mimeType: string,
): { type: "image" | "video" | "audio" | "file"; mimeType: string } {
  const mime = String(mimeType || "").toLowerCase();
  const kind = mediaKindForMime(mime === "application/octet-stream" ? "" : mime, meta.label || meta.name);
  if (kind === "image") {
    // 图片：快照下发**缩略图**（base64）让手机直接看到，原图由客户端按 key 拉。
    // 缩略图生成/缺失的兜底在调用方（ipc.ts 的 attachBlockForMeta）：没有缩略图就退成 file 卡。
    return { type: "image", mimeType: mime.startsWith("image/") ? mime : "image/jpeg" };
  }
  if (kind === "video") {
    return { type: "video", mimeType: mime.startsWith("video/") ? mime : videoMimeForPath(meta.label || meta.name || "") };
  }
  if (kind === "audio") {
    return { type: "audio", mimeType: mime.startsWith("audio/") ? mime : mediaMimeForPath(meta.label || meta.name || "") };
  }
  return { type: "file", mimeType: mimeType || "application/octet-stream" };
}

/**
 * 入库失败时的兜底引用：**不带** `attach=` 标记（快照不为它生成块，与历史行为一致），
 * 但把失败原因写进去，免得 agent 以为文件不存在。
 */
export function desktopFilePlainEnvelope(meta: DesktopFileMeta, reason: string): string {
  const esc = (value: string) => String(value).replace(/"/g, "&quot;");
  return `\n\n<file name="${esc(meta.label)}" path="${esc(meta.abs)}" note="${esc(reason)}" />`;
}

/**
 * 判定 + 生成（**唯一**给 `processAttachments` 用的入口）。
 *
 * @param opts.store  入库函数；返回 null = 插件库拒绝（磁盘错误/超配额）
 * @param opts.inline 该文件是否走「内联全文」分支（调用方已按 shouldInlineDesktopText 判定）
 */
export function planDesktopFile(meta: DesktopFileMeta, opts: {
  inline: boolean;
  store: StoreObjectFn;
  mediaKind: "image" | "audio" | "video" | "file";
}): DesktopFilePlan {
  if (opts.inline) return { kind: "inline" };
  const mediaKind = opts.mediaKind;
  let stored: { name: string; abs: string; size: number } | null = null;
  try {
    stored = opts.store({ sourcePath: meta.abs, label: meta.label, mime: meta.mime });
  } catch {
    stored = null;
  }
  if (!stored) {
    // 入库失败（配额满 / 磁盘错 / 文件已被移走）：退回旧行为（裸引用），并把原因写给模型。
    return { kind: "plain", reason: "attached; could not be added to MPI's attachment library (agent can still read this path)" };
  }
  return {
    kind: "ref",
    name: stored.name,
    abs: stored.abs,
    size: stored.size,
    ...(sha256RefKey(stored.name) ? { key: sha256RefKey(stored.name) } : {}),
    mediaKind,
  };
}
