/**
 * 多设备切换（2026-10-19 真机：thinkbook 的 PWA 绑了 workstation + MiniBox，
 * 刷新后切到 MiniBox 就 `NOT_FOUND: Thread not found`，而且切不回去）。
 *
 * 根因：`startSession` 只 `setSession(null)`（要等下一次 render 才生效），而 `enterHome`
 * 立刻用 `sessionRef.current` 判断要不要新建 HostSession —— 于是**复用了上一台主机的会话**：
 * 列表还是 workstation 的，点开的 threadId 发给 MiniBox 就是 NOT_FOUND；
 * 又因为 `hostId` 已经改成 MiniBox，`switchHost` 的 `if (hostId === record.hostId) return`
 * 让再次点击变成空操作（界面永久卡死）。
 *
 * 这里钉住三条不变量（源码契约，防止回归）：
 *   1. startSession 在 detach 后同步清 sessionRef；
 *   2. switchHost 用「会话实际所属主机」判定，而不是渲染态的 hostId；
 *   3. disconnect 把两个 ref 一起清掉。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
// 源文件是 CRLF：统一成 LF 再做形状断言（否则正则永远不匹配）。
const src = readFileSync(join(ROOT, "mobile/pwa/src/App.tsx"), "utf8").split(CRLF).join(LF);

// 1) startSession：detach 后立刻把 ref 置空 + 记录归属主机
assert.match(
  src,
  /sessionRef\.current = null;\n\s*sessionHostRef\.current = record\.hostId;/,
  "startSession 必须在 detach 后同步清 sessionRef 并记录 sessionHostRef",
);

// 2) switchHost：不再用渲染态 hostId 提前返回
assert.match(
  src,
  /if \(record\.hostId === sessionHostRef\.current && sessionRef\.current\) return;/,
  "switchHost 必须按 sessionHostRef 判定，不能因 hostId 已切就空操作",
);
assert.doesNotMatch(src, /if \(record\.hostId === hostId\) return;/, "旧判据不能再出现（切换失败后会卡死）");

// 3) disconnect：两个 ref 都要清
assert.match(
  src,
  /sessionRef\.current = null;\n\s*sessionHostRef\.current = null;/,
  "disconnect 要同时清 sessionHostRef",
);

console.log("pwa-host-switch：3 条不变量全部满足");
