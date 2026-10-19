/**
 * 多设备切换（2026-10-19 真机：thinkbook 的 PWA 绑了 workstation + MiniBox，
 * 刷新后切到 MiniBox 就 `NOT_FOUND: Thread not found`，而且切不回去）。
 *
 * 根因（三处叠加）：
 *   ① `startSession` 只 `setSession(null)`（等下一次 render 才生效），而 `enterHome`
 *      立刻用 `sessionRef.current` 判断要不要新建 HostSession → 复用了上一台主机的会话；
 *   ② 首页快照 `snap` 切换时没作废 → 「自动打开最近会话」的 effect 会拿上一台的
 *      threadId 去新主机开会话（client 已换）→ NOT_FOUND；
 *   ③ `switchHost` 用渲染态 hostId 提前返回；hostId 已改 → 再点空操作，界面卡死。
 *
 * 这里钉住五条不变量（源码契约）。断言用 substring 定位而不是正则，避免 CRLF/转义坑。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const src = readFileSync(join(ROOT, "mobile/pwa/src/App.tsx"), "utf8").split(CRLF).join(LF);

/** 从 `needle` 起往后取 `len` 个字符（找不到就返回空串）。 */
function windowAfter(needle, len = 400) {
  const at = src.indexOf(needle);
  return at < 0 ? "" : src.slice(at, at + len);
}

// 1) startSession：detach 后同步清 sessionRef，并记录 sessionHostRef
{
  const start = src.indexOf("const startSession = (record");
  assert.ok(start > 0, "必须能找到 startSession");
  const w = src.slice(start, start + 900);
  assert.ok(w.includes("sessionRef.current = null;"), "startSession 必须在 detach 后同步清 sessionRef");
  assert.ok(w.includes("sessionHostRef.current = record.hostId;"), "startSession 必须记录会话归属主机");
}
console.log("[1] startSession 同步清 sessionRef + 记录归属");

// 2) 切换时立刻作废旧主机快照
{
  const w = windowAfter("sessionHostRef.current = record.hostId;", 600);
  assert.ok(w.includes("setSnap(null);"), "startSession 必须在切换时清空 snap（否则自动开会话拿到旧 threadId）");
}
console.log("[2] 切换时作废旧首页快照");

// 3) 会话为空时也清 snap
{
  const w = windowAfter("if (!session) {", 400);
  assert.ok(w.includes("setSnap(null);"), "session 为空时要清 snap，不能留上一台的数据");
}
console.log("[3] 会话为空时清空 snap");

// 4) switchHost：不再用渲染态 hostId 提前返回
assert.ok(
  src.includes("if (record.hostId === sessionHostRef.current && sessionRef.current) return;"),
  "switchHost 必须按 sessionHostRef 判定",
);
assert.ok(!src.includes("if (record.hostId === hostId) return;"), "旧判据不能再出现（切换失败后会卡死）");
console.log("[4] switchHost 判据正确");

// 5) disconnect：两个 ref 一起清
{
  const at = src.indexOf("const disconnect = () => {");
  assert.ok(at > 0, "disconnect 必须存在");
  const w = src.slice(at, at + 800);
  assert.ok(w.includes("sessionRef.current = null;"), "disconnect 要清 sessionRef");
  assert.ok(w.includes("sessionHostRef.current = null;"), "disconnect 要清 sessionHostRef");
}
console.log("[5] disconnect 双清 ref");

console.log("pwa-host-switch：5 条不变量全部满足");
