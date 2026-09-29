/**
 * 聊天附件的**持久落盘区**（视频这类「要在对话框里长期可播」的媒体）。
 *
 * 为什么不用 `%TEMP%/mpi-clipboard`：那是 `stageClipboardFile` 的通用粘贴暂存区，属于
 * 「随时可清理」的语义（系统存储清理、清理工具都会动它）。而消息里的视频引用是**会话历史
 * 的一部分**——文件没了，历史里那条消息就只能退化成占位卡片（2026-09-28 真机已踩到：
 * 「提示过期被清理了」）。所以视频单独存到 `<userData>/chat-attachments/`。
 *
 * 目录策略：只收视频（内联播放用），单个 ≤ CHAT_VIDEO_MAX_BYTES（超过的仍走普通文件引用，
 * 不进这里）；总量超过 MAX_DIR_BYTES 时按 mtime 从旧到新删到限额内。
 *
 * 2026-09-28：单个上限从 3MB（当时“能内联”的上限）放宽到 REMOTE_VIDEO_MAX_BYTES——
 * 大视频不再需要内联也能看（客户端点开按需拉，见 attachment.fetch），所以「能不能存」
 * 不该再受「能不能内联」制约。
 */
import { app } from "electron";
import { closeSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { REMOTE_VIDEO_MAX_BYTES, VIDEO_EXT_BY_MIME, VIDEO_POSTER_MAX_BYTES, VIDEO_POSTER_MIME_TYPES, posterNameFor, videoMimeForPath } from "./remote/video-refs";

export const CHAT_ATTACHMENT_DIR = "chat-attachments";
/**
 * 目录总量上限（超出按 mtime 删最旧的）。
 *
 * 从 300MB 提到 1GB：视频不再内联后，附件区是它们唯一的家（消息里只留名字），
 * 删掉就是真的“看不了”；而 128MB 的单文件上限下，300MB 只装得下两三个视频。
 */
const MAX_DIR_BYTES = 1024 * 1024 * 1024;

const VIDEO_EXTS = new Set([".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi"]);
/** 同一个集合的数组形式（需要遍历 / `.some()` 的地方用）。 */
const VIDEO_EXT_LIST: string[] = [...VIDEO_EXTS];

/** 是不是「可内联播放的视频」文件（按扩展名）。 */
export const isVideoFile = (name: string): boolean => VIDEO_EXTS.has(extname(name).toLowerCase());

/** 文件名白名单（与 chatatt:// 协议共用）：uuid-名字.ext，不含任何路径成分。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;

function dir(create = true): string {
  const target = join(app.getPath("userData"), CHAT_ATTACHMENT_DIR);
  if (create) mkdirSync(target, { recursive: true });
  return target;
}

/** 统一命名：`<uuid>-<原名>`（uuid 保证不撞名，原名保留可读性）。 */
function stagedName(originalName: string): string {
  const safe = basename(String(originalName || "video.mp4"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 120) || "video.mp4";
  return `${randomUUID()}-${safe}`;
}

/** 调用方（上传/拖入）可能带一张首帧封面。 */
export interface VideoPosterInput {
  data: string;
  mimeType?: string;
}

/** 校验并写入封面文件；不合法（太大/类型不支持/写失败）→ 返回 null，视频本身不受影响。 */
function writePoster(videoName: string, poster?: VideoPosterInput): string | null {
  if (!poster || typeof poster.data !== "string" || !poster.data) return null;
  const mimeType = String(poster.mimeType || "image/jpeg").toLowerCase();
  if (!VIDEO_POSTER_MIME_TYPES.has(mimeType)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(poster.data, "base64");
  } catch {
    return null;
  }
  if (!bytes.length || bytes.length > VIDEO_POSTER_MAX_BYTES) return null;
  // 名字从视频名派生（两个名字同源，客户端靠 `poster="…"` 属性找到它）。
  const name = posterNameFor(videoName, mimeType);
  try {
    writeFileSync(join(dir(), name), bytes);
    return name;
  } catch {
    return null;
  }
}

/**
 * 手机端发来的视频（base64，已在内存里）→ 落盘（含可选首帧封面）。
 * 超过 REMOTE_VIDEO_MAX_BYTES 直接抛错（调用方本来就已按同一上限校验过）。
 */
export function stageChatVideoBytes(args: { name?: string; mimeType?: string; data: string; poster?: VideoPosterInput }): { abs: string; name: string; size: number; posterName: string | null } {
  const bytes = Buffer.from(String(args.data || ""), "base64");
  if (!bytes.length) throw new Error("video attachment is empty");
  if (bytes.length > REMOTE_VIDEO_MAX_BYTES) throw new Error("video attachment is too large");
  // 走内容寻址：同一份视频（已在库）不再重复落盘，只登记引用；回来的是 **key**（不是 uuid 名）。
  const stored = storeObject({
    bytes,
    ...(args.name ? { label: args.name } : {}),
    ...(args.mimeType ? { mime: args.mimeType } : {}),
    ...(args.poster ? { poster: args.poster } : {}),
  });
  if (!stored) throw new Error("video attachment could not be stored");
  return stored;
}

/**
 * 桌面端选/拖进来的视频文件 → **复制**进附件区（原文件保持不动），返回新名字。
 *
 * 复制而不是引用原路径：① 原文件可能被移动/删除，而会话历史要能长期回看；
 * ② `chatatt://` 只服务这一个目录，不允许渲染层随意指路径。
 *
 * 上限用 REMOTE_VIDEO_MAX_BYTES（128MB）而不是内联阈值：桌面端拖进来的大视频同样要能在
 * 手机/PWA 上点开看（那边走 attachment.fetch 按需拉），所以不该在这里就被挡掉。
 */
export function adoptChatVideo(filePath: string, poster?: VideoPosterInput): { abs: string; name: string; size: number; posterName: string | null } | null {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > REMOTE_VIDEO_MAX_BYTES) return null;
    // 内容寻址：先算哈希；同一内容（含手机端已上传过的同一视频）直接命中，不再复制一份。
    const stored = storeObject({
      sourcePath: filePath,
      label: basename(filePath),
      mime: videoMimeForPath(filePath),
      ...(poster ? { poster } : {}),
    });
    return stored;
  } catch {
    return null;
  }
}

/** 旧落盘目录（历史遗留）：附件曾在 `%TEMP%/mpi-clipboard`。那里属于“随时可清理”的语义，
 * 所以新附件不再往那儿放；但为了不让**已有的历史消息**凭空变成占位卡片，找不到时回这里看一眼。 */
const LEGACY_TEMP_DIR = "mpi-clipboard";

/** 按文件名解析成磁盘路径（chatatt:// 协议用）；不合法或不存在 → null。 */
export function resolveChatAttachment(name: string): string | null {
  if (!name || !NAME_RE.test(name) || name.includes("..")) return null;
  // 内容寻址的对象（P1+，见 docs/attachment-content-addressing.md）：名字本身就是 SHA-256。
  if (isContentKey(name)) {
    const abs = objectExistingPath(String(name).toLowerCase());
    if (abs) {
      touchObject(name);
      return abs;
    }
    // 没落盘（上传中途/已清理）→ 按 404 处理
    return null;
  }
  // 存量去重（P2）后的遗留名：盘上那份已被合并进对象库，靠别名解析（会话文件不动）。
  const aliased = aliasFor(name);
  if (aliased) {
    const abs = objectExistingPath(aliased);
    if (abs) {
      touchObject(aliased);
      return abs;
    }
  }
  const candidates = [join(dir(false), name), join(app.getPath("temp"), LEGACY_TEMP_DIR, name)];
  for (const target of candidates) {
    if (basename(target) !== name) continue;
    try {
      if (statSync(target).isFile()) return target;
    } catch {
      /* 继续看下一个候选位置 */
    }
  }
  return null;
}

/**
 * 单次按需取字节（`attachment.fetch`）最多回传的**原始**字节数。
 *
 * base64 后 ≈683KB，离 8MB 的 envelope 硬上限（protocol.ts 的 MAX_ENVELOPE_BYTES）
 * 还有十倍余量；客户端不需要知道这个值——它只按响应里的 `length` 往前推进，
 * 所以扩容只改这里，不用同步改客户端（省掉一类漂移守卫）。
 */
export const ATTACHMENT_FETCH_CHUNK_BYTES = 512 * 1024;

/** 只读需要的区间，不把整个文件读进内存（视频按需播放会连发分片请求）。 */
export function readSlice(path: string, start: number, end: number): Buffer {
  const length = end - start + 1;
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

/**
 * 按需取回附件的**一段字节**（远程客户端播视频用）。
 *
 * 名字合法性、目录包含关系都由 resolveChatAttachment 统一把关（不合法/文件不在 → null，
 * 调用方一律按 404 处理，不区分「名字非法」与「文件已被清理」——避免成为探测接口）。
 * offset 由客户端推进，服务端按 CHUNK 上限**夹紧**并回传实际长度与 eof，
 * 客户端据此循环，不必自己算分片边界。
 */
export function readAttachmentSlice(
  name: string,
  offset: number,
  maxBytes = ATTACHMENT_FETCH_CHUNK_BYTES,
): { abs: string; size: number; offset: number; eof: boolean; data: Buffer } | null {
  const abs = resolveChatAttachment(name);
  if (!abs) return null;
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    return null;
  }
  const start = Math.floor(offset);
  if (!Number.isFinite(start) || start < 0 || size <= 0 || start >= size) return null;
  const limit = Math.min(Math.max(1, Math.floor(maxBytes) || ATTACHMENT_FETCH_CHUNK_BYTES), ATTACHMENT_FETCH_CHUNK_BYTES);
  const end = Math.min(size, start + limit);
  return { abs, size, offset: start, eof: end >= size, data: readSlice(abs, start, end - 1) };
}

/** 上传分包的后缀（收齐后原子改名成正式名）。与 NAME_RE 兼容，不会与正式名撞。 */
export const UPLOAD_PART_SUFFIX = ".part";

// ---------------------------------------------------------------------------------------------
// 内容寻址对象层（P1）：附件名 = 内容的 SHA-256（小写 hex）。
//
// 为什么要它：同一个视频在两个会话各发一次，旧做法是两份物理副本（各占一遍空间，且手机端
// 按「附件名」缓存 → 两遍下载）；而且主机侧一旦写坏字节，客户端只能看到一个「播不了」的
// 黑盒。改成内容寻址后：① 同一内容只有一份；② 客户端缓存 key 换成哈希，跨会话共享；
// ③ 收齐时主机自己算一遍哈希与客户端声明比对 —— 写坏/链路损坏会**在上传时就失败**
// （2026-09-29 的落盘错位事故就是缺了这一步才让主机「一切成功」地写坏了视频）。
//
// 兼容：老消息引用的是 `<uuid>-原名.mp4`（平铺在根目录），仍然照旧可读，不搬不重写。
// ---------------------------------------------------------------------------------------------

/** 内容 key：SHA-256 小写 hex（恰好 64 位）。 */
export const SHA256_RE = /^[a-f0-9]{64}$/;

/** 一个对外名字是不是内容 key（老消息里是 `<uuid>-原名.mp4`，两种都得能读）。 */
export function isContentKey(name: string): boolean {
  return SHA256_RE.test(String(name || "").toLowerCase()) && String(name || "") === String(name || "").toLowerCase();
}

/** 对象查找时按顺序探测的扩展名（与视频扩展名同一份定义，避免两处漂移）。 */
const OBJECT_EXT_CANDIDATES = VIDEO_EXT_LIST;

/** 对象的扩展名：优先用调用方给的 mime，其次查索引，最后 .mp4。
 *
 * 为什么对象文件名要带扩展名：服务端靠它给 Content-Type（网页端 <video> 不吃 octet-stream），
 * 快照也靠它推视频 mime——key 本身没有任何可读信息。 */
function objectExtFor(key: string, mimeHint?: string): string {
  const mime = String(mimeHint || readIndex()[key]?.mime || "").toLowerCase();
  return VIDEO_EXT_BY_MIME[mime] || ".mp4";
}

/** 对象所在的分片目录（`objects/<前两位>`，避免单目录堆几十万文件）。 */
function objectShardDir(key: string): string {
  return join(dir(false), "objects", key.slice(0, 2));
}

/** 对象的落盘路径（含扩展名；不建目录，建目录由写入方负责）。 */
function objectPath(key: string, mimeHint?: string): string {
  return join(objectShardDir(key), key + objectExtFor(key, mimeHint));
}

/** 已存在的对象文件（索引里的 mime 优先，其次探测候选扩展名）；没有 → null。 */
function objectExistingPath(key: string): string | null {
  const candidates = [objectPath(key), ...OBJECT_EXT_CANDIDATES.map((ext) => join(objectShardDir(key), key + ext))];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

interface AttachmentObjectRecord {
  size: number;
  mime?: string;
  /** 可读的原文件名（界面展示用；key 本身没有可读信息）。 */
  label?: string;
  createdAt: number;
  lastUsedAt: number;
}

interface AttachmentIndexFile {
  version: 1;
  objects: Record<string, AttachmentObjectRecord>;
  /**
   * 遗留名（`<uuid>-原名.mp4`）→ 内容 key 的别名。
   *
   * 存量去重（P2）后，老消息里写的是遗留名，而盘上只剩一份内容对象——别名就是两者之间的桥：
   * **不动会话文件**（历史消息永不重写），只把名字映射到对象上。删除对象前应先查别名。
   */
  aliases?: Record<string, string>;
}

const indexFilePath = (): string => join(dir(true), "index.json");

function readIndexFile(): AttachmentIndexFile {
  try {
    const parsed = JSON.parse(readFileSync(indexFilePath(), "utf8")) as AttachmentIndexFile;
    if (parsed && typeof parsed === "object") {
      return {
        version: 1,
        objects: parsed.objects && typeof parsed.objects === "object" ? parsed.objects : {},
        aliases: parsed.aliases && typeof parsed.aliases === "object" ? parsed.aliases : {},
      };
    }
  } catch {
    /* 没索引 / 解析失败 → 当作空索引（对象仍可按物理文件读） */
  }
  return { version: 1, objects: {}, aliases: {} };
}

function writeIndexFile(file: AttachmentIndexFile): void {
  try {
    writeFileSync(indexFilePath(), JSON.stringify({ version: 1, objects: file.objects, aliases: file.aliases ?? {} }, null, 2), "utf8");
  } catch {
    /* 索引写失败不能影响读写本体：它是元数据（可读名/lastUsedAt/别名），不是真相源 */
  }
}

function readIndex(): Record<string, AttachmentObjectRecord> {
  return readIndexFile().objects;
}

function writeIndex(objects: Record<string, AttachmentObjectRecord>): void {
  const file = readIndexFile();
  file.objects = objects;
  writeIndexFile(file);
}

/** 遗留名 → 内容 key（没有别名 → null）。 */
export function aliasFor(name: string): string | null {
  const value = String(name || "");
  if (!value) return null;
  const key = readIndexFile().aliases?.[value];
  return key && isContentKey(key) ? key : null;
}

/** 记一条别名（把老名字指到内容对象上）。 */
export function setAlias(legacyName: string, key: string): void {
  const name = String(legacyName || "");
  const value = String(key || "").toLowerCase();
  if (!name || !isContentKey(value)) return;
  const file = readIndexFile();
  file.aliases = { ...(file.aliases || {}), [name]: value };
  writeIndexFile(file);
}

/** 流式计算文件 SHA-256（1MB 一块，不把 128MB 读进内存）。失败 → null。 */
export function sha256OfFile(abs: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(abs, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** 内存里的字节 → SHA-256。 */
export function sha256OfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 该对象是否已经在库（以物理文件为准，索引可能滞后）。 */
export function hasObject(key: string): boolean {
  if (!isContentKey(key)) return false;
  return objectExistingPath(String(key).toLowerCase()) !== null;
}

/** 读取对象元数据（不存在 → null；以物理文件为准）。 */
export function objectMeta(key: string): AttachmentObjectRecord | null {
  if (!hasObject(key)) return null;
  return readIndex()[key] || { size: 0, createdAt: 0, lastUsedAt: 0 };
}

/** 登记/更新对象元数据（label 只在首次登记时写入，后来的同内容上传不覆盖它）。 */
export function registerObject(key: string, meta: { size?: number; mime?: string; label?: string }): void {
  const value = String(key || "").toLowerCase();
  if (!isContentKey(value)) return;
  const objects = readIndex();
  const now = Date.now();
  const previous = objects[value];
  objects[value] = {
    size: meta.size ?? previous?.size ?? 0,
    ...(meta.mime || previous?.mime ? { mime: meta.mime || previous?.mime } : {}),
    ...(previous?.label || meta.label ? { label: previous?.label || meta.label } : {}),
    createdAt: previous?.createdAt || now,
    lastUsedAt: now,
  };
  writeIndex(objects);
}

/**
 * 读过的对象刷一次 lastUsedAt（GC 排序用）。
 *
 * 只在「超过一小时没动过」时才写盘：按需播放一次几十个 Range 请求，每个都写索引会把盘写爆。
 */
function touchObject(key: string): void {
  const value = String(key || "").toLowerCase();
  if (!isContentKey(value)) return;
  const objects = readIndex();
  const record = objects[value];
  const now = Date.now();
  if (record && now - record.lastUsedAt < 60 * 60 * 1000) return;
  objects[value] = { ...(record || { size: 0, createdAt: now }), lastUsedAt: now };
  writeIndex(objects);
}

/**
 * 收齐一个**内容寻址**的上传：先校哈希，再进对象库。
 *
 * 校验放这里（而不是调用方）是因为它要读整个分片临时文件；调用方只拿一个三态结果。
 * 哈希不符 → **不落成品**并删临时文件：宁可让客户端重传，也不能把坏字节当成成品存档。
 */
export function finalizeUploadedObject(
  partName: string,
  expectedKey: string,
  meta: { mime?: string; label?: string } = {},
): { ok: true; key: string; abs: string; size: number; deduped: boolean } | { ok: false; reason: "checksum" | "missing" | "io" } {
  const key = String(expectedKey || "").toLowerCase();
  if (!isContentKey(key)) return { ok: false, reason: "io" };
  const part = uploadPartPath(partName);
  if (!part) return { ok: false, reason: "io" };
  try {
    if (!existsSync(part)) return { ok: false, reason: "missing" };
    const actual = sha256OfFile(part);
    if (!actual) return { ok: false, reason: "io" };
    if (actual !== key) return { ok: false, reason: "checksum" };
    const size = statSync(part).size;
    // 并发重传同一内容：先到的那份已经进库 → 直接丢掉这一份（内容相同，没有信息损失）。
    if (hasObject(key)) {
      unlinkSync(part);
      registerObject(key, { size, ...meta });
      return { ok: true, key, abs: objectExistingPath(key) as string, size, deduped: true };
    }
    mkdirSync(objectShardDir(key), { recursive: true });
    const abs = objectPath(key, meta.mime);
    renameSync(part, abs);
    registerObject(key, { size, ...meta });
    return { ok: true, key, abs, size, deduped: false };
  } catch {
    return { ok: false, reason: "io" };
  }
}

/**
 * 本地已有的字节/文件 → 对象库（桌面端拖入与 PWA 内联上传都走这里）。
 *
 * 已有同一内容 → **不重复落盘**，只登记引用（这正是「相同文件不重复存放」）。
 */
export function storeObject(args: {
  bytes?: Buffer;
  sourcePath?: string;
  label?: string;
  mime?: string;
  poster?: VideoPosterInput;
}): { abs: string; name: string; size: number; posterName: string | null; deduped: boolean } | null {
  try {
    let key: string;
    let size: number;
    const source = args.sourcePath;
    if (source) {
      const stats = statSync(source);
      if (!stats.isFile() || stats.size <= 0) return null;
      size = stats.size;
      const hashed = sha256OfFile(source);
      if (!hashed) return null;
      key = hashed;
    } else {
      const bytes = args.bytes;
      if (!bytes || !bytes.length) return null;
      size = bytes.length;
      key = sha256OfBytes(bytes);
    }
    const known = hasObject(key);
    if (!known) {
      mkdirSync(objectShardDir(key), { recursive: true });
      const abs = objectPath(key, args.mime);
      if (source) copyFileSync(source, abs);
      else writeFileSync(abs, args.bytes as Buffer, { flag: "wx" });
    }
    registerObject(key, { size, ...(args.mime ? { mime: args.mime } : {}), ...(args.label ? { label: args.label } : {}) });
    // 封面按 key 命名（`<key>.poster.jpg`，与老命名规则同形，所以老解析路径不用改）。
    return { abs: objectExistingPath(key) as string, name: key, size, posterName: writePoster(key, args.poster), deduped: known };
  } catch {
    return null;
  }
}

/** 为一个即将上传的视频**预分配**名字（客户端拿到它才是要 PUT 的目标）。 */
export function reserveVideoName(originalName?: string, mimeType?: string): string {
  const extension = VIDEO_EXT_BY_MIME[String(mimeType || "").toLowerCase()] || ".mp4";
  return stagedName(originalName || `video-${Date.now()}${extension}`);
}

/** 分片临时文件路径（不存在也算合法——写入时创建）。 */
export function uploadPartPath(name: string): string | null {
  if (!NAME_RE.test(name) || name.includes("..")) return null;
  return join(dir(), `${name}${UPLOAD_PART_SUFFIX}`);
}

/**
 * 写入一个上传分片（定位写），返回已收字节数。
 *
 * 定位写而不是追加：客户端可重传某个分片（弱网断点续传），而不用从头再来。
 */
export function writeUploadChunk(name: string, offset: number, chunk: Buffer): number {
  const target = uploadPartPath(name);
  if (!target) throw new Error("invalid upload name");
  // ⚠️ 这里**不能**用 `openSync(target, "a+")`：追加模式下写位置会被忽略（Windows 上尤其如此），
  // 分片就按**到达顺序**被拼起来。手机端是 3 片并发发的（0.5.112 起），到达顺序不是 0/1/2，
  // 结果落盘的视频整段错位——主机侧一切“成功”，客户端播不了（2026-09-29 真机「不能看」根因）。
  // 用 O_RDWR|O_CREAT（文件不存在则创建、存在则原样保留）取代 "a+"，位置才会被尊重。
  const fd = openSync(target, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o666);
  try {
    writeSync(fd, chunk, 0, chunk.length, offset);
  } finally {
    closeSync(fd);
  }
  return statSync(target).size;
}

/** 放弃上传（客户端取消/超时）→ 删掉临时文件。 */
export function abandonUpload(name: string): void {
  const target = uploadPartPath(name);
  if (!target) return;
  try {
    unlinkSync(target);
  } catch {
    /* 没建过就算了 */
  }
}

/**
 * 收齐后把 `.part` 原子改名成正式名（`rename` 是同盘原子操作，不会出现半截文件被当成成品）。
 * 若目标已存在（重传完成）→ 删除临时文件，结果一样。
 */
export function completeUploadedVideo(name: string): { abs: string; size: number } | null {
  const part = uploadPartPath(name);
  if (!part) return null;
  const target = join(dir(), name);
  try {
    if (!existsSync(part)) return existsSync(target) ? { abs: target, size: statSync(target).size } : null;
    renameSync(part, target);
    return { abs: target, size: statSync(target).size };
  } catch {
    return null;
  }
}

/** 封面落盘（供上传流程调用；与 `stageChatVideoBytes` 内部用同一个实现）。 */
export function storeVideoPoster(videoName: string, poster?: VideoPosterInput): string | null {
  return writePoster(videoName, poster);
}

/**
 * 找已存在的封面文件名（上传完成后回填信封时用）。
 *
 * 封面扩展名取决于上传时的 MIME，所以三个候选都要看（不能拿 .jpg hardcode）。
 */
export function findVideoPoster(videoName: string): string | null {
  const base = posterNameFor(videoName, "image/jpeg").replace(/\.jpg$/i, "");
  for (const extension of [".jpg", ".png", ".webp"]) {
    const candidate = `${base}${extension}`;
    if (resolveChatAttachment(candidate)) return candidate;
  }
  return null;
}

/** GC 报告（也是「超上限提示」的数据来源）。 */
export interface AttachmentGcReport {
  totalBytes: number;
  maxBytes: number;
  freedBytes: number;
  removed: string[];
  /** 因为「被会话引用」而没动的大小（字节）。 */
  protectedBytes: number;
  /** 清完无人引用的仍超上限 → 需要用户自己处理（不再静默删别人的附件）。 */
  overCapacity: boolean;
  /** 引用集合是否可用；不可用时**不删任何东西**（宁可不腾空间，也不能删掉还在用的附件）。 */
  liveSetAvailable: boolean;
}

export interface AttachmentGcOptions {
  /** 收集「被会话引用过的名字」（视频名 + 封面名）。不提供 = 没启用引用保护。 */
  collectReferenced?: () => Promise<Set<string> | null>;
  /** 超上限且无可删对象时的回调（用户可见的提示）。 */
  onOverCapacity?: (report: AttachmentGcReport) => void;
}

/** 对象目录下的全部对象（key 从文件名去掉扩展名得到）。 */
function listObjects(): Array<{ key: string; abs: string; size: number; lastUsedAt: number }> {
  const out: Array<{ key: string; abs: string; size: number; lastUsedAt: number }> = [];
  const root = join(dir(false), "objects");
  if (!existsSync(root)) return out;
  const index = readIndex();
  for (const shard of readdirSync(root)) {
    const shardDir = join(root, shard);
    let files: string[];
    try {
      files = readdirSync(shardDir);
    } catch {
      continue;
    }
    for (const name of files) {
      const key = name.replace(/\.[A-Za-z0-9]+$/, "");
      if (!isContentKey(key)) continue;
      try {
        const stats = statSync(join(shardDir, name));
        if (!stats.isFile()) continue;
        out.push({ key, abs: join(shardDir, name), size: stats.size, lastUsedAt: index[key]?.lastUsedAt || stats.mtimeMs });
      } catch {
        /* 列目录期间被删了 → 忽略 */
      }
    }
  }
  return out;
}

/** 名字 → 它所属的「附件名」（封面名去掉 `.poster.<ext>` 后缀；其他原样）。 */
export function ownerNameOf(name: string): string {
  return String(name || "").replace(/\.poster\.(jpg|jpeg|png|webp)$/i, "");
}

/** 把一个视频名/内容 key 对应的封面候选名（与老命名规则一致）。 */
export function posterNamesFor(name: string): string[] {
  return [posterNameFor(name, "image/jpeg"), posterNameFor(name, "image/png"), posterNameFor(name, "image/webp")];
}

/**
 * 按总量上限清理附件（启动时调用）。
 *
 * **P2 起的行为变化**：不再做「按 mtime 从旧到新删」——那样会把别的会话还在引用的附件
 * 静默删掉（消息变成占位卡片）。现在只删**没有任何会话引用**的吗？不是——只删引用集合里
 * 没有的那些；引用集合拿不到就**一个都不删**（宁可不腾空间）。超上限剩下的部分交给用户。
 */
export async function pruneChatAttachments(maxBytes = MAX_DIR_BYTES, options: AttachmentGcOptions = {}): Promise<AttachmentGcReport> {
  const report: AttachmentGcReport = {
    totalBytes: 0,
    maxBytes,
    freedBytes: 0,
    removed: [],
    protectedBytes: 0,
    overCapacity: false,
    liveSetAvailable: false,
  };
  try {
    const target = dir(false);
    if (!existsSync(target)) return report;

    // 先清掉没人的上传残留（.part）：它们只可能是「上传中途程序退出」留下的。
    const cleanupPart = (name: string): boolean => {
      try {
        unlinkSync(join(target, name));
        report.removed.push(name);
        return true;
      } catch {
        return false;
      }
    };
    const staleCutoff = Date.now() - 60 * 60 * 1000;
    for (const name of readdirSync(target)) {
      if (!name.endsWith(UPLOAD_PART_SUFFIX)) continue;
      try {
        const stats = statSync(join(target, name));
        if (!stats.isFile() || stats.mtimeMs > staleCutoff) continue;
        const size = stats.size;
        if (cleanupPart(name)) report.freedBytes += size;
      } catch {
        /* 忽略 */
      }
    }

    const objects = listObjects();
    const legacy = readdirSync(target)
      .filter((name) => {
        const lower = name.toLowerCase();
        if (name.endsWith(UPLOAD_PART_SUFFIX) || name.endsWith(".json")) return false;
        return VIDEO_EXT_LIST.some((ext) => lower.endsWith(ext)) || /\.poster\.(jpg|jpeg|png|webp)$/i.test(lower);
      })
      .map((name) => {
        try {
          const stats = statSync(join(target, name));
          return stats.isFile() ? { name, size: stats.size, mtime: stats.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { name: string; size: number; mtime: number } => entry !== null);

    report.totalBytes =
      objects.reduce((sum, entry) => sum + entry.size, 0) + legacy.reduce((sum, entry) => sum + entry.size, 0);
    if (report.totalBytes <= maxBytes) return report;

    const live = options.collectReferenced ? await options.collectReferenced() : null;
    report.liveSetAvailable = live !== null;
    if (!live) {
      // 引用集合不可用：**什么都不删**。老行为（mtime LRU）会把在用的附件删掉，
      // 而「主机是最全备份」的前提恰恰是不能静默删。宁可超着，让用户自己清。
      report.overCapacity = true;
      options.onOverCapacity?.(report);
      return report;
    }

    // 引用集合 → 受保护的 key 集合（直接引用的 key、封面指向的 key、以及遗留名别名到的 key）
    const protectedKeys = new Set<string>();
    const protectedNames = new Set<string>();
    for (const raw of live) {
      const name = String(raw || "");
      if (!name) continue;
      protectedNames.add(name);
      const owner = ownerNameOf(name);
      protectedNames.add(owner);
      if (isContentKey(name)) protectedKeys.add(name);
      else {
        const aliased = aliasFor(name);
        if (aliased) protectedKeys.add(aliased);
      }
      if (isContentKey(owner)) protectedKeys.add(owner);
      else {
        const aliased = aliasFor(owner);
        if (aliased) protectedKeys.add(aliased);
      }
    }

    const deletable = legacy
      .filter((entry) => {
        const owner = ownerNameOf(entry.name);
        // 视频名或它的封面名任一被引用 → 整个附件都留着。
        return !protectedNames.has(entry.name) && !protectedNames.has(owner);
      })
      .map((entry) => ({ kind: "legacy" as const, name: entry.name, size: entry.size, order: entry.mtime }));
    const deletableObjects = objects
      .filter((entry) => !protectedKeys.has(entry.key))
      .map((entry) => ({ kind: "object" as const, name: entry.key, size: entry.size, order: entry.lastUsedAt, abs: entry.abs }));

    report.protectedBytes =
      report.totalBytes - [...deletable, ...deletableObjects].reduce((sum, entry) => sum + entry.size, 0);

    let remaining = report.totalBytes;
    const candidates = [...deletable, ...deletableObjects].sort((a, b) => a.order - b.order);
    for (const entry of candidates) {
      if (remaining <= maxBytes) break;
      try {
        // ⚠️ 对象的路径已经是绝对路径，**不能**再 `join(target, …)`（那样会拼出一个
        // 不存在的路径，删除永远失败——2026-09-29 被单测抓到：对象因此永远清不掉）。
        if (entry.kind === "legacy") unlinkSync(join(target, entry.name));
        else unlinkSync(entry.abs);
      } catch {
        continue;
      }
      report.removed.push(entry.name);
      report.freedBytes += entry.size;
      remaining -= entry.size;
      // 跟着删它的封面（封面不被别处引用时）
      for (const posterName of posterNamesFor(entry.name)) {
        if (protectedNames.has(posterName)) continue;
        try {
          const stats = statSync(join(target, posterName));
          unlinkSync(join(target, posterName));
          report.freedBytes += stats.size;
          remaining -= stats.size;
        } catch {
          /* 没封面就算了 */
        }
      }
    }
    report.totalBytes = remaining;
    report.overCapacity = remaining > maxBytes;
    if (report.overCapacity) options.onOverCapacity?.(report);
    return report;
  } catch {
    /* 清理失败不能影响启动 */
    return report;
  }
}

/** 附件区现状（诊断 / 维护脚本用）。 */
export function attachmentStorageReport(): {
  totalBytes: number;
  objectBytes: number;
  legacyBytes: number;
  objectCount: number;
  aliasCount: number;
  legacyCount: number;
} {
  const file = readIndexFile();
  const objects = listObjects();
  const target = dir(false);
  let legacyBytes = 0;
  let legacyCount = 0;
  if (existsSync(target)) {
    for (const name of readdirSync(target)) {
      if (!VIDEO_EXT_LIST.some((ext) => name.toLowerCase().endsWith(ext))) continue;
      try {
        const stats = statSync(join(target, name));
        if (!stats.isFile()) continue;
        legacyBytes += stats.size;
        legacyCount += 1;
      } catch {
        /* 忽略 */
      }
    }
  }
  const objectBytes = objects.reduce((sum, entry) => sum + entry.size, 0);
  return {
    totalBytes: objectBytes + legacyBytes,
    objectBytes,
    legacyBytes,
    objectCount: objects.length,
    aliasCount: Object.keys(file.aliases || {}).length,
    legacyCount,
  };
}

// ---- 存量去重（P2）----------------------------------------------------------------

/** 去重校验的块大小：与上传分片一致（4MB）——损坏就是按这个粒度错位的。 */
const MERGE_CHUNK_BYTES = 4 * 1024 * 1024;

/** 逐个 4MB 块的 sha1（用于「这两份文件是不是同一内容的块序置换」）。 */
function chunkDigests(abs: string): string[] | null {
  try {
    const size = statSync(abs).size;
    const out: string[] = [];
    for (let offset = 0; offset < size; offset += MERGE_CHUNK_BYTES) {
      const slice = readSlice(abs, offset, Math.min(offset + MERGE_CHUNK_BYTES, size) - 1);
      out.push(createHash("sha1").update(slice).digest("hex"));
    }
    return out;
  } catch {
    return null;
  }
}

/** 两个多重集是否相等（顺序无关）。 */
function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) || 0) + 1);
  for (const item of b) {
    const next = (counts.get(item) || 0) - 1;
    if (next < 0) return false;
    counts.set(item, next);
  }
  return true;
}

/**
 * 合并「同一内容的多个副本」（含块序错位的那种）。
 *
 * 用法：`keep` 是正确的那一份，`duplicates` 是重复/损坏的副本。校验方式是**逐 4MB 块的多重集
 * 相等**（块序可以不同）——这正是 2026-09-29 那次「a+ 追加导致落盘错位」的形态：所有块都在，
 * 只是顺序错了。校验不过就**拒绝合并**（宁可浪费空间，也不能把两份不同内容错当一份）。
 *
 * 合并不是改会话文件：老名字会写进别名表（`index.json` 的 `aliases`），所以历史消息照旧能解析。
 */
export function mergeDuplicateAttachments(
  keep: string,
  duplicates: string[],
  options: { apply?: boolean } = {},
): { ok: boolean; reason?: string; key?: string; reclaimedBytes: number; aliased: string[]; merged: string[] } {
  const result = { ok: false, reclaimedBytes: 0, aliased: [] as string[], merged: [] as string[] };
  const keepPath = resolveChatAttachment(keep);
  if (!keepPath) return { ...result, reason: "keep-not-found" };
  const keepChunks = chunkDigests(keepPath);
  if (!keepChunks) return { ...result, reason: "keep-unreadable" };
  // 先全量校验，再动磁盘：半途失败最坏的不一致就是「别名已改但文件还在」，那也无害。
  const checked: Array<{ name: string; path: string; size: number }> = [];
  for (const duplicate of duplicates) {
    if (duplicate === keep) continue;
    const path = resolveChatAttachment(duplicate);
    if (!path) return { ...result, reason: `duplicate-not-found:${duplicate}` };
    const size = statSync(path).size;
    if (size !== statSync(keepPath).size) return { ...result, reason: `size-mismatch:${duplicate}` };
    const chunks = chunkDigests(path);
    if (!chunks || !sameMultiset(keepChunks, chunks)) return { ...result, reason: `content-mismatch:${duplicate}` };
    checked.push({ name: duplicate, path, size });
  }

  const key = isContentKey(keep) ? keep : (sha256OfFile(keepPath) as string | null);
  if (!key) return { ...result, reason: "keep-hash-failed" };
  if (!options.apply) return { ok: true, key, reclaimedBytes: checked.reduce((sum, item) => sum + item.size, 0), aliased: [], merged: [] };

  // ① 把 keep 收进对象库（已经是对象就只需要补登记）
  if (!hasObject(key)) {
    try {
      mkdirSync(objectShardDir(key), { recursive: true });
      if (isContentKey(keep)) {
        // 理论到不了这里（是 key 却 hasObject=false）——当作失败而不猜。
        return { ...result, reason: "keep-object-missing" };
      }
      renameSync(keepPath, objectPath(key));
      registerObject(key, { size: statSync(objectPath(key)).size });
    } catch {
      return { ...result, reason: "promote-failed" };
    }
  }
  if (!isContentKey(keep)) setAlias(keep, key);

  // ② 副本：写别名（历史消息仍指向老名字）+ 删文件（内容已是同一份，不丢数据）
  for (const item of checked) {
    setAlias(item.name, key);
    try {
      unlinkSync(item.path);
      result.reclaimedBytes += item.size;
      result.merged.push(item.name);
    } catch {
      /* 删不掉就留着（别名已经生效，不丢功能，只多占空间） */
    }
    result.aliased.push(item.name);
  }
  return { ...result, ok: true, key };
}
