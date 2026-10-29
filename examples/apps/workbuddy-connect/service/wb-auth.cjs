"use strict";
/**
 * WorkBuddy 本机登录态的读取与解密。
 *
 * WorkBuddy 5.6+ 起不再把 `auth.accessToken` 存成明文，而是写成
 * `{ "$wbEncrypted": 1, "envelope": "<base64>" }`，envelope 是 AES-256-GCM
 * （suite + keyId + nonce + authTag + ciphertext），AAD 是按字段框架拼的一段
 * transcript。字段密钥不是用户机密：它是 App 原生模块里的构建期常量，App 自己
 * 通过 `loggerGet()` 取回 base64 字符串、对**字符串本身**做 SHA-256 得到 32 字节
 * 密钥；`keyId` 是这把密钥 SHA-256 的前 16 个十六进制字符。
 *
 * 这里做的同一件事：用 WorkBuddy 自己的二进制以 `ELECTRON_RUN_AS_NODE=1` 跑一段
 * 内联脚本拿 payload，再按同样规则派生密钥、打开字段。密钥只在内存里，
 * 不落盘、不写日志。
 */

const { execFileSync } = require("node:child_process");
const { createDecipheriv, createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
const STANDARD_FORMAT_ID_FIELD = "WBEV1";
const SYMMETRIC_SCHEME = "sym-v1";
const FRAMING_CODE_FIELD = 2;
const KEY_FETCH_TIMEOUT_MS = 20000;

const u32 = (n) => {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n);
  return b;
};
const lp = (s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([u32(b.length), b]);
};

/** 字段框架的 AAD（与 App 逐字节对齐；顺序错了会 GCM 校验失败）。 */
function fieldAad(keyId, suite) {
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    lp(STANDARD_FORMAT_ID_FIELD),
    lp(SYMMETRIC_SCHEME),
    u32(suite),
    lp(keyId),
    Buffer.from([FRAMING_CODE_FIELD]),
    Buffer.from([0]), // 字段框架没有 sequence
    Buffer.from([0]), // final = undefined
  ]);
}

/** WorkBuddy.exe 的候选位置（本机绿色版、Program Files、LocalAppData、常见盘符）。 */
function exeCandidates() {
  const out = [];
  const env = process.env.WORKBUDDY_APP_EXECUTABLE;
  if (env && env.trim()) out.push(env.trim());
  const local = process.env.LOCALAPPDATA || "";
  const roaming = process.env.APPDATA || "";
  const pf = process.env.ProgramFiles || "C:/Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
  if (local) out.push(join(local, "Programs", "WorkBuddy", "WorkBuddy.exe"));
  if (local) out.push(join(local, "WorkBuddy", "WorkBuddy.exe"));
  if (roaming) out.push(join(roaming, "WorkBuddy", "WorkBuddy.exe"));
  out.push(join(pf, "WorkBuddy", "WorkBuddy.exe"));
  out.push(join(pf86, "WorkBuddy", "WorkBuddy.exe"));
  for (const drive of ["C:", "D:", "E:", "F:"]) {
    for (const sub of ["WorkBuddy", "Software/WorkBuddy", "Program Files/WorkBuddy", "Apps/WorkBuddy"]) {
      out.push(join(drive + "/", sub, "WorkBuddy.exe"));
    }
  }
  return out;
}

function resolveExe() {
  for (const candidate of exeCandidates()) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  // 还找不到：问正在运行的 WorkBuddy 进程要路径（用户可能装在任意目录）。
  if (process.platform === "win32") {
    try {
      const out = execFileSync("wmic", ["process", "where", "name='WorkBuddy.exe'", "get", "ExecutablePath"], {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
      });
      for (const line of out.split(/\r?\n/)) {
        const candidate = line.trim();
        if (candidate && /WorkBuddy\.exe$/i.test(candidate) && existsSync(candidate)) return candidate;
      }
    } catch {
      /* wmic 不可用就继续报错 */
    }
  }
  throw new Error(
    "找不到 WorkBuddy.exe：请先安装并登录 WorkBuddy 桌面端，或设置环境变量 WORKBUDDY_APP_EXECUTABLE 指向它。",
  );
}

/** 凭据文件候选（Windows 两个 AppData、macOS、Linux）。 */
function credentialPaths() {
  const out = [];
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  if (local) out.push(join(local, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"));
  if (roaming) out.push(join(roaming, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"));
  const home = homedir();
  out.push(join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"));
  out.push(join(home, ".config", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"));
  return out;
}

function resolveCredentialPath() {
  for (const candidate of credentialPaths()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("找不到 WorkBuddy 登录凭据：请先在 WorkBuddy 桌面端登录一次。");
}

/** 向 App 要字段密钥 payload（只走本机进程，不联网）。 */
function fetchKeyPayload(exe) {
  const script =
    "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}" +
    "catch(e){process.stdout.write('ERR:'+(e&&e.message||String(e)))}";
  const out = execFileSync(exe, ["-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: KEY_FETCH_TIMEOUT_MS,
    windowsHide: true,
  });
  if (out.startsWith("ERR:")) throw new Error("WorkBuddy 取字段密钥失败：" + out.slice(4));
  let payload;
  try {
    payload = JSON.parse(out);
  } catch {
    throw new Error("WorkBuddy 返回的字段密钥不是合法 JSON");
  }
  if (!payload || typeof payload.atRestSecretKey !== "string" || !payload.atRestSecretKey) {
    throw new Error("WorkBuddy 返回的字段密钥缺少 atRestSecretKey");
  }
  return payload;
}

function deriveKey(payload) {
  // App 哈希的是 base64 **字符串**本身，不是解码后的字节。
  return createHash("sha256").update(payload.atRestSecretKey, "utf8").digest();
}

function openField(field, key) {
  if (!field || typeof field !== "object" || field.$wbEncrypted !== 1 || typeof field.envelope !== "string") {
    throw new Error("凭据字段不是预期的加密包装");
  }
  const envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
  const { suite, keyId, nonce, authTag, ciphertext } = envelope || {};
  if (typeof suite !== "number" || typeof keyId !== "string") throw new Error("凭据 envelope 缺少 suite/keyId");
  if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") {
    throw new Error("凭据 envelope 缺少 nonce/authTag/ciphertext");
  }
  const expectedKeyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (keyId !== expectedKeyId) throw new Error("凭据字段属于另一把密钥（App 可能已升级）");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
  decipher.setAAD(fieldAad(keyId, suite));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/**
 * 读当前登录态并解密出 accessToken。
 * @returns {{ token: string, uid: string, domain: string, expiresAt: number|undefined, exe: string }}
 */
function readCredential() {
  const exe = resolveExe();
  const doc = JSON.parse(readFileSync(resolveCredentialPath(), "utf8"));
  const key = deriveKey(fetchKeyPayload(exe));
  const token = openField(doc.auth && doc.auth.accessToken, key);
  return {
    token,
    uid: (doc.account && doc.account.uid) || "",
    domain: (doc.auth && doc.auth.domain) || "",
    expiresAt: (doc.auth && doc.auth.expiresAt) || undefined,
    exe,
  };
}

module.exports = { readCredential, resolveExe, resolveCredentialPath };
