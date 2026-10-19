/**
 * 模型显示名（2026-10-19）——「id 一律要过映射」的回归闸门。
 *
 * 背景：会话文件与消息元数据里只有裸 id（`"model":"deepseek-flash"`），
 * 显示名（“DeepSeek V4.1 Flash”）只存在于模型列表里。之前两处直接渲染 id：
 *   · 对话框消息底部（`Chat.tsx`）
 *   · 冷会话的模型 pill（磁盘快照只有 {provider,id}）
 *
 * 这里钉住回退规则：有 name 用 name；查不到用 id；**宁可显示 id 也不能显示空白**。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { modelLabel, modelShort } = await import("../src/renderer/src/lib/format.ts");

const models = [
  { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
  { provider: "new-provider", id: "qwen3.8-27b@q5_k_m", name: "Qwen 3.8 27B (Q5_K_M)" },
  { provider: "deepseek", id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
];

// 1) 消息里的裸 id → 显示名（对话框底部走这条）
assert.equal(modelLabel("deepseek-flash", models), "DeepSeek V4.1 Flash");
console.log("[1] 裸 id 映射成显示名");

// 2) 没有模型列表（冷会话 / 桥没开）→ 原样显示 id，不能空白
assert.equal(modelLabel("deepseek-flash", []), "deepseek-flash");
assert.equal(modelLabel("deepseek-flash", undefined), "deepseek-flash");
console.log("[2] 无列表时回落 id");

// 3) 对象自带 name 直接用（打开中的会话：pi 的 state.model）
assert.equal(modelLabel({ provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" }, []), "DeepSeek V4.1 Flash");
console.log("[3] 自带 name 优先");

// 4) 冷会话的 {provider,id}：靠列表补名
assert.equal(modelLabel({ provider: "deepseek", id: "deepseek-flash" }, models), "DeepSeek V4.1 Flash");
console.log("[4] {provider,id} 补名");

// 5) provider 对不上时不要张冠李戴（同名 id 可能存在于多个供应商）
assert.equal(
  modelLabel({ provider: "someone-else", id: "deepseek-flash" }, models),
  "deepseek-flash",
  "provider 不匹配时应回落 id，不能借用别家的 name",
);
console.log("[5] provider 不匹配时不借用别家显示名");

// 6) name 与 id 相同（如 deepseek-v4-flash）→ 显示名就是它自己
assert.equal(modelLabel("deepseek-v4-flash", models), "deepseek-v4-flash");
console.log("[6] name === id 正常显示");

// 7) 空值不产生空白节点
assert.equal(modelLabel("", models), "");
assert.equal(modelLabel(null, models), "");
assert.equal(modelLabel(undefined, models), "");
console.log("[7] 空值返回空串");

// 8) pill 的截断规则没被这次改动带偏
assert.equal(modelShort({ provider: "x", id: "a", name: "DeepSeek V4.1 Flash" }), "DeepSeek V4.1 Flash");
assert.equal(modelShort({ provider: "x", id: "a", name: "x".repeat(30) }).endsWith("…"), true);
assert.equal(modelShort(null), "model");
console.log("[8] modelShort 截断行为不变");

console.log("\n模型显示名：8 项全部通过");
