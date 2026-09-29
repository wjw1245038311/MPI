/**
 * 推送载荷的内容约束（见 docs/RELAY-SHARING.md §四）。
 *
 * 为什么这是一条**隐私红线**而不是代码风格：`push.request` 是**明文控制帧**，中继要用它自己的
 * VAPID 私钥代做 Web Push 加密，所以**中继必然能看到 title/body/deepLink 的明文**。
 * 一旦有人往里塞「回复摘要 / 文件名 / 会话标题」，中继运营者就能读到朋友的内容——
 * 而这是本轮「分享给朋友」最不能破的一条（内容加密是这个服务的卖点）。
 *
 * 所以这里做**源码级守卫**：所有 `sendPush(...)` 调用点的 title/body 必须是字符串字面量，
 * deepLink 只允许 `/thread/<id>` 这一种形状。新增推送必须走这个形状，否则测试失败。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("../", import.meta.url)));
const SRC = join(ROOT, "src", "main");

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 取出每个 sendPush(...) 调用的实参文本（按括号配平，够用且不引第三方解析器）。 */
function extractSendPushCalls(source) {
  const calls = [];
  let index = source.indexOf("sendPush(");
  while (index >= 0) {
    let depth = 0;
    let cursor = index + "sendPush".length;
    const start = cursor;
    for (; cursor < source.length; cursor += 1) {
      const ch = source[cursor];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(start, cursor));
    index = source.indexOf("sendPush(", cursor);
  }
  return calls;
}

const LITERAL = /^(?:[`"'][^`"']*[`"'])$/;

/** 一个字段的值是不是「固定文案」（字面量，且不含插值）。 */
function literalValue(call, field) {
  // 值里可能含 `}`（模板字面量 `${x}`），所以只能以逗号作为字段边界（我们的载荷对象都是平铺的）。
  const match = call.match(new RegExp(`${field}\\s*:\\s*([^,]+)`));
  if (!match) return null;
  return match[1].trim().replace(/[)\s}]+$/, "").trim();
}

const files = listTsFiles(SRC);
let checked = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("sendPush(")) continue;
  for (const call of extractSendPushCalls(source)) {
    // 定义处（relay-uplink.ts 的接口/实现）不是调用点，跳过。
    if (/^\s*$/.test(call) || call.includes("push:")) continue;
    for (const field of ["title", "body"]) {
      const value = literalValue(call, field);
      if (value === null) continue;
      assert.ok(
        LITERAL.test(value),
        `${file}: 推送的 ${field} 必须是固定文案字面量（中继能看到它的明文），实际：${value.slice(0, 80)}`,
      );
      assert.ok(
        !value.includes("${"),
        `${file}: 推送的 ${field} 不能含插值（那等于把内容送进中继的明文通道），实际：${value.slice(0, 80)}`,
      );
    }
    const deepLink = literalValue(call, "deepLink");
    if (deepLink !== null) {
      // 允许 `/thread/<字面量>` 或 `/thread/${threadId}` 这种单一插值——多一个字符都不行：
      // deepLink 也是中继可见的明文。
      const shape = /^[`"']\/thread\/(?:\$\{[A-Za-z0-9_.]+\}|[A-Za-z0-9_-]+)?[`"']$/;
      assert.ok(shape.test(deepLink), `${file}: 推送的 deepLink 只允许 /thread/<id>（不能塞其它内容），实际：${deepLink.slice(0, 80)}`);
    }
    checked += 1;
  }
}

assert.ok(checked > 0, "至少要检查到一个推送调用点（否则这条守卫形同虚设——说明正则或代码结构变了）");
console.log(`ok - 推送载荷内容约束（检查了 ${checked} 个调用点：title/body 必须固定文案，deepLink 只允许 /thread/<id>）`);
console.log("push-privacy tests passed");
