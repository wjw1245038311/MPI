/**
 * 交付纪律规则的回归测试。
 *
 * 为什么需要：规则是**行为契约**——删掉一句，模型的行为就退回原样，但没有任何编译期
 * 或功能测试会失败。所以这里断言两件事：
 *   ① 规则文本本身仍然含有那两条约束的关键子句（防被人"顺手精简"掉）；
 *   ② `append-prompt.ts` 真的把它拼进了追加提示词（防它变成孤儿模块）。
 *
 * 证据背景见 `src/main/agent-rules.ts` 的注释：S4（该问不问）、S2（把推断写成硬规则）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { AGENT_DISCIPLINE_RULES } = await import("../src/main/agent-rules.ts");

// --- ① 规则文本本身 ---
assert.equal(typeof AGENT_DISCIPLINE_RULES, "string", "AGENT_DISCIPLINE_RULES 必须是字符串");
assert.ok(AGENT_DISCIPLINE_RULES.length > 200, "规则文本太短，像被截断了");

// 规则 1：该问就问，不许把假设当结论
assert.match(AGENT_DISCIPLINE_RULES, /不确定项|拿不准/, "规则 1 丢了「先列不确定项」的触发词");
assert.match(AGENT_DISCIPLINE_RULES, /缺什么信息|不同取值的后果/, "规则 1 丢了「每条要写清什么」的要求");
assert.match(AGENT_DISCIPLINE_RULES, /禁止.*假设往下做|不要把假设当结论/, "规则 1 丢了「不许直接按假设往下做」的禁令");

// 规则 2：分清文档明写与推断
assert.match(AGENT_DISCIPLINE_RULES, /文档明写|字面/, "规则 2 丢了「文档明写」这一侧");
assert.match(AGENT_DISCIPLINE_RULES, /推断/, "规则 2 丢了「推断」这一侧");
assert.match(AGENT_DISCIPLINE_RULES, /出处|文件\s*\+\s*条款/, "规则 2 丢了「必须指明出处」的要求");

// --- ② 真的被拼进追加提示词 ---
const src = readFileSync(new URL("../src/main/append-prompt.ts", import.meta.url), "utf8");
assert.match(src, /AGENT_DISCIPLINE_RULES/, "append-prompt.ts 没有引用 AGENT_DISCIPLINE_RULES（规则成了孤儿模块）");
assert.match(src, /buildAppendSystemPrompt[\s\S]{0,400}AGENT_DISCIPLINE_RULES/, "AGENT_DISCIPLINE_RULES 没被放进 buildAppendSystemPrompt 的 parts 里");

console.log("agent-rules tests passed");
