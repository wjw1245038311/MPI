/**
 * 远程通道路径脱敏（redactRemotePaths）单测——2026-10-10 真机事故回归：
 * PWA 用户消息含 https 链接时，旧正则把 `https://` 里的 `s:/` 当盘符路径吃掉，
 * 事件通道文本变成 `http[path]`，与快照（原样）不一致 → 乐观回显对账失败、气泡重复。
 *
 *   1. URL 不再误伤（http/https/ftp scheme + 端口 + 中文引号包裹的事故原文）
 *   2. 真路径照旧脱敏（Windows 盘符 / UNC / Unix 家目录前缀，含 CJK 紧邻无空格场景）
 */
import assert from "node:assert/strict";

const { redactRemotePaths } = await import("../src/main/remote/path-redact.ts");

// ---- 1. URL 不再误伤 ---------------------------------------------------------
{
  const urls = [
    "是'https://47.97.28.110:9443/assets/index-CBe1qq4s.js'", // 事故原文，必须原样
    "查清了。你浏览器加载的 https://47.97.28.110:9443/ 就是 ECS",
    "本地服务 http://127.0.0.1:8765 已起",
    "tailnet https://workstation.tail38d5a.ts.net:8765/",
    "备用 ftp://files.example.com/pub/x.zip 与 [链接](https://example.com/a?b=c)",
  ];
  for (const s of urls) {
    assert.equal(redactRemotePaths(s), s, `URL 文本必须原样通过：${s}`);
  }
}

// ---- 2. 真路径照旧脱敏 -------------------------------------------------------
{
  const cases = [
    ["文件在 E:\\MyWorkspace\\Project\\MPI\\x.ts", "文件在 [path]"],
    ["看 C:/Users/admin/a.txt 这个", "看 [path] 这个"],
    ["UNC \\\\server\\share\\file.log 打不开", "UNC [path] 打不开"],
    ["日志 /var/log/syslog 有报错", "日志 [path] 有报错"],
    ["家目录 /home/weijw2/x.yml 改一下", "家目录 [path] 改一下"],
    // CJK 紧邻盘符（中文里不加空格）——lookbehind 只挡 ASCII 字母，不能误放行。
    ["文件在E:\\MyWorkspace\\x.txt 里", "文件在[path] 里"],
    // 引号包裹的 Windows 路径。
    ['"E:\\secret\\file.json"', '"[path]"'],
  ];
  for (const [input, want] of cases) {
    assert.equal(redactRemotePaths(input), want, `应脱敏：${input}`);
  }
}

// ---- 3. 混合文本：URL 与路径并存时各归各位 ------------------------------------
{
  const mixed = "服务在 https://host:8765/，配置是 E:\\cfg\\app.json";
  assert.equal(redactRemotePaths(mixed), "服务在 https://host:8765/，配置是 [path]");
}

console.log("remote path-redact tests passed");
