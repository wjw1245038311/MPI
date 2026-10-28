import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * 「导出会话」= 一个**能直接导入回 MPI / pi 桌面端**的会话包（zip），不是人读的 Markdown。
 *
 * 包结构（与备份包的目录约定一致，导入端按同一套规则落盘）：
 *
 *   <项目目录名>/<会话文件>.jsonl   ← 原始会话文件，逐字节原样（图片是 base64 inline，自带）
 *   attachments/<引用名>            ← 会话里 `<file … attach="media|video" … name="X" />` 用到的附件
 *   manifest.json                   ← kind="session-export" + 标题/项目/附件清单（含 mime/label/大小）
 *
 * 为什么不改 jsonl 里的引用：附件卡片是按 `name` 走 `chatatt://` 协议取字节的，
 * 只要本机附件库里存在同名对象（或同名别名），引用就自动可用 —— 所以导出/导入
 * 只需保证「同名文件到位」，不必重写会话内容，也就不会破坏 pi 的会话格式。
 */

/** 导出文件名基线：去掉 Windows 非法字符、限长，空则回退 session。 */
export function exportFileName(title: string): string {
  const cleaned = String(title || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "session";
}

/**
 * 会话里所有附件引用名（`<file … attach="media|video" … name="X" />`），按出现顺序去重。
 *
 * 必须**逐行 JSON.parse** 后再扫：jsonl 里信封是 JSON 字符串，原文中引号被转义成 `\"`，
 * 直接对原始文本做正则匹配不到属性。（图片是 base64 inline，不在这里，也不需要单独打包。）
 */
export function collectAttachmentNames(jsonl: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const scan = (text: string) => {
    if (!text || !text.includes("attach=")) return;
    const tag = /<file\b[^>]*?\/>/g;
    let m: RegExpExecArray | null;
    while ((m = tag.exec(text))) {
      const t = m[0];
      const attach = /\sattach="([^"]*)"/i.exec(t)?.[1] ?? "";
      if (attach !== "media" && attach !== "video") continue;
      const name = /\sname="([^"]*)"/i.exec(t)?.[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  };
  for (const line of String(jsonl || "").split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 坏行跳过：导出以能读到的部分为准
    }
    const content = entry?.message?.content;
    if (typeof content === "string") scan(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") scan(block.text);
      }
    }
  }
  return out;
}

export interface AttachmentSource {
  /** 引用名 → 本机绝对路径（附件库；含别名/遗留临时文件解析）。没有 → null。 */
  pathFor(name: string): string | null;
  /** 引用名 → 附件库元数据（内容 key / mime / 原文件名 / 大小）。没有 → null。 */
  metaFor(name: string): { key?: string | null; size?: number; mime?: string; label?: string } | null;
}

export interface SessionExportOptions {
  /** session .jsonl 的绝对路径。 */
  file: string;
  title: string;
  cwd?: string | null;
  appVersion?: string;
  attachments: AttachmentSource;
}

export interface SessionExportAttachment {
  name: string;
  key?: string | null;
  size?: number;
  mime?: string;
  label?: string;
}

export interface SessionExportManifest {
  app: "MPI";
  kind: "session-export";
  version: 1;
  exportedAt: string;
  appVersion?: string;
  title: string;
  cwd?: string | null;
  sessionFile?: string;
  attachments: SessionExportAttachment[];
}

/** 会话语义上的「项目目录名」：会话文件所在目录（`--E--ws-Project-MPI--` 这种编码名）。 */
export function projectDirNameFor(file: string): string {
  const dir = basename(dirname(file));
  return dir && dir !== "." && dir !== ".." ? dir : "imported";
}

/**
 * 生成会话包 zip。返回写入的附件数量（0 = 会话里没有外部附件）。
 * 单个附件缺失/超限只跳过该附件，不让整包失败（会话本体仍可导入）。
 */
export async function exportSessionZip(
  outPath: string,
  opts: SessionExportOptions,
  limits: { maxAttachmentBytes?: number } = {},
): Promise<{ ok: true; attachments: number; skipped: number } | { ok: false; error: string }> {
  const maxBytes = limits.maxAttachmentBytes ?? 1024 * 1024 * 1024;
  let jsonl: Buffer;
  try {
    jsonl = readFileSync(opts.file);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
  try {
    const mod = await import("jszip");
    const JSZip = (mod as any).default ?? mod;
    const zip = new JSZip();
    zip.file(`${projectDirNameFor(opts.file)}/${basename(opts.file)}`, jsonl);

    const records: SessionExportAttachment[] = [];
    let skipped = 0;
    for (const name of collectAttachmentNames(jsonl.toString("utf8"))) {
      const abs = opts.attachments.pathFor(name);
      if (!abs || !existsSync(abs)) {
        skipped += 1;
        continue;
      }
      try {
        const size = statSync(abs).size;
        if (size > maxBytes) {
          skipped += 1;
          continue;
        }
        zip.file(`attachments/${name}`, readFileSync(abs));
        const meta = opts.attachments.metaFor(name) ?? {};
        records.push({
          name,
          ...(meta.key ? { key: meta.key } : {}),
          size,
          ...(meta.mime ? { mime: meta.mime } : {}),
          ...(meta.label ? { label: meta.label } : {}),
        });
      } catch {
        skipped += 1;
      }
    }

    const manifest: SessionExportManifest = {
      app: "MPI",
      kind: "session-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
      title: opts.title,
      cwd: opts.cwd ?? null,
      sessionFile: basename(opts.file),
      attachments: records,
    };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, buf);
    return { ok: true, attachments: records.length, skipped };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 导出包的默认文件名（不含扩展名）。 */
export function exportBaseName(title: string, file: string): string {
  return exportFileName(title) || basename(file).replace(/\.jsonl$/i, "") || "session";
}

/** 保存框的默认路径（文档目录）。给 IPC 层用，单独抽出来便于测试。 */
export function defaultExportPath(documentsDir: string, title: string, file: string): string {
  return join(documentsDir, `${exportBaseName(title, file)}.zip`);
}
