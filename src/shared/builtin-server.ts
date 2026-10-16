/**
 * **内置服务器**（用户的 ECS 中继）—— 地址以混淆形式内置在软件里。
 *
 * 设计（2026-10-16 定稿，见「服务器」分栏）：
 *  · 有**授权码**的机器可以直接用内置服务器转发对话 + 从它的镜像更新，界面上看不到地址；
 *  · 没有授权码的机器只能配「自定义服务器」，更新走 GitHub。
 *
 * ⚠️ **这不是安全机制，只是防 grep**：解密密钥必须随包一起发出去，反编译（或翻这个公开仓的
 * 源码）都能还原出地址。真正拦人的是**服务端的授权码校验**（中继的 `RELAY_HOST_TOKENS` +
 * 镜像的 `RELAY_APP_TOKENS`），以及安装包的 Bearer 门控。所以这里只做「不要一眼看见」，
 * 不值得为它引入任何更复杂的东西（KDF 只到 sha256 一级）。
 *
 * 只在主进程 import（用 node:crypto；渲染层不该拿到地址）。改地址 = 改这里的明文再重新生成密文：
 *   node -e "…"（见 git 历史里那条一次性命令）；解析失败一律返回 null，调用方按「内置服务器不可用」处理。
 */
import { createDecipheriv, createHash } from "node:crypto";

/** 明文 = `{hostUplinks:[],phoneUrls:[],mirrorUrl:""}`；密文 = base64(iv[12] | tag[16] | ct)。 */
const BUILTIN_SERVER_BLOB =
  "bXBpLWJ1aWx0LTE2zqOdhGpSeHlwSl5vvBysh0UMLQmhYP0KN06s9YSKArunPSr8sXMJfm2qN0NHwyisk3VZ8ax1XuX3L5uLL/noh6ribB0pxxI017kdPZaI9NT9dIjkZ0UrcDuwH78r9C20e6I6uxpsUAlXIXQZVWPq1ZYV7e9J6W/lgUzp1gT8HXaDnBFrO+lOY4OisMBSL5yNilDgOnYSSr16OrFzwMXAMn8UvEswcFSnKwN8fHR3beBUF9mclf29ros4Puomi0BCHhnziYUJtCAmD/be9quGJU1EmmBbP1j+NWYS1S7rYwcXi3GiGATiPg==";

/** 混淆密钥（防 grep 级别；见文件头注释）。 */
const OBFUSCATION_KEY = createHash("sha256").update("mpi-builtin-server-v1|9f5c1d").digest();

export interface BuiltinServer {
  /**
   * 主机上行候选地址，**按序尝试**：tailnet 上的 TLS 入口在前（本机在有 tailnet 时走它，
   * 内容经 TLS），公网明文入口兜底（没有 tailnet 的机器走它——中继只转发不解析，
   * 应用层还有 E2E 加密，与手机走明文是同一条路）。
   */
  hostUplinks: string[];
  /** 配对票里给手机的地址：原生 App 用公网明文，PWA 用公网 TLS（HTTPS 页面不允许连明文 ws）。 */
  phoneUrls: string[];
  /** 桌面端自更新的镜像 feed（`<中继>/download/app/`）。 */
  mirrorUrl: string;
}

/** 只保留 ws(s)/http(s) 且非空的地址，去重保序。 */
function sanitizeUrls(value: unknown, protocols: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const url = String(raw || "").trim();
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!protocols.includes(parsed.protocol)) continue;
    const normalized = parsed.toString();
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * 解出内置服务器描述。解密/结构校验失败返回 null（调用方当作「内置服务器不可用」，
 * 绝不让一个坏常量把启动流程带崩）。
 */
export function builtinServer(): BuiltinServer | null {
  let parsed: unknown;
  try {
    const blob = Buffer.from(BUILTIN_SERVER_BLOB, "base64");
    if (blob.length <= 28) return null;
    const decipher = createDecipheriv("aes-256-gcm", OBFUSCATION_KEY, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const hostUplinks = sanitizeUrls(record.hostUplinks, ["ws:", "wss:"]);
  const phoneUrls = sanitizeUrls(record.phoneUrls, ["ws:", "wss:"]);
  const mirrorUrl = sanitizeUrls([record.mirrorUrl], ["http:", "https:"])[0] || "";
  if (!hostUplinks.length || !phoneUrls.length) return null;
  return { hostUplinks, phoneUrls, mirrorUrl };
}
