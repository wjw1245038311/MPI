/**
 * choices 自动重试扩展的判定逻辑测试
 *
 * 扩展开关与注入动作依赖 pi 运行时（agent_settled + pi.sendMessage），没法在单测里跑；
 * 但「该不该重试」这段是纯函数，而且它是唯一会误伤正常对话的地方（误判 = 把正常
 * 提问强行改成面板），所以必须锁住边界。
 *
 * 运行：npm run test:choiceretry
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { inspectChoices, isValidChoicesBody, detectFailure, retryHint, lastAssistantText, turnKey, textOfContent, qaModeIsManual, clearUsedRetryInstructions } =
  await import("../src/main/mpi-choice-retry-ext.ts");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};
const fence = (body, info = "choices") => "```" + info + "\n" + body + "\n```";

// ---- [1] 合法块 ------------------------------------------------------------
{
  const text = "先说明两点：\n\n" + fence('[{"title":"用什么方案？","options":["甲","乙"]}]') + "\n\n后记。";
  const info = inspectChoices(text);
  assert.equal(info.fenced, true, "应识别出 choices 围栏");
  assert.equal(info.validBlocks, 1);
  assert.equal(info.broken, false);
  assert.equal(detectFailure(text), null, "合法块不应触发重试");
  ok("合法围栏：识别成功且不重试");
}

// ---- [2] 选项对象用 detail / label 两种写法 --------------------------------
{
  assert.equal(
    isValidChoicesBody('[{"title":"题","options":[{"label":"甲","detail":"说明"},"乙"]}]'),
    true,
    "label + detail 应合法",
  );
  assert.equal(
    isValidChoicesBody('[{"title":"题","options":[{"title":"甲","detail":"说明"},"乙"]}]'),
    false,
    "选项写成 title 应判非法（真实失败形态）",
  );
  assert.equal(isValidChoicesBody('[{"title":"题","options":["只有一项"]}]'), false, "单选项应判非法");
  assert.equal(isValidChoicesBody("[]"), false, "空数组应判非法");
  assert.equal(
    isValidChoicesBody(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ title: "q" + i, options: ["a", "b"] })))),
    false,
    "超过 6 题应判非法",
  );
  ok("结构校验：label/title、单选项、空数组、超 6 题");
}

// ---- [3] 语法坏块：中文串里裸英文双引号 ------------------------------------
{
  const text = fence('[{"title":"用哪个？","options":["方案 "甲" 好","方案乙"]}]');
  const info = inspectChoices(text);
  assert.equal(info.fenced, true);
  assert.equal(info.validBlocks, 0);
  assert.equal(info.broken, true);
  const fail = detectFailure(text);
  assert.ok(fail, "裸引号应触发重试");
  assert.match(fail.reason, /JSON|label/, "失败原因要能指导模型改哪里");
  ok("syntax 坏块（裸引号）：触发重试且原因可用");
}

// ---- [4] 形态错一：choices 单独一行 + 下一行 ```json -----------------------
{
  const text = 'choices\n```json\n[{"title":"题","options":["甲","乙"]}]\n```';
  const info = inspectChoices(text);
  assert.equal(info.validBlocks, 0, "```json 围栏不是 choices 围栏");
  assert.equal(info.missingShape, true, "应识别出「choices 写在围栏外」");
  assert.ok(detectFailure(text), "形态错应触发重试");
  ok("形态错：choices 在围栏外 → 触发重试");
}

// ---- [5] 形态错二：空围栏 + 下一行 choices --------------------------------
{
  const text = "```\nchoices\n" + '[{"title":"题","options":["甲","乙"]}]\n```';
  assert.equal(inspectChoices(text).missingShape, true);
  assert.ok(detectFailure(text));
  ok("形态错：空 info 围栏 + choices 下一行 → 触发重试");
}

// ---- [6] 未闭合围栏（模型把闭合粘在 JSON 末尾也必须算坏） ------------------
{
  const text = "```choices\n" + '[{"title":"题","options":["甲","乙"]}]';
  const info = inspectChoices(text);
  assert.equal(info.validBlocks, 1, "正文合法就算一个块（与渲染层容错一致）");
  assert.equal(detectFailure(text), null);
  ok("未闭合但正文合法：不重试（与渲染层容错保持一致）");
}

// ---- [7] 纯文本提问不重试（防误伤） --------------------------------------
{
  for (const text of [
    "我先说明一下思路，然后问你三个问题：\n1. 用哪个模型？\n2. 什么时候发版？\n3. 谁负责验收？",
    "choices 这个机制在弱模型上容易坏，建议加一次重试。",
    "```js\nconst x = 1;\n```",
  ]) {
    assert.equal(detectFailure(text), null, "不该把正常文本判成失败：" + text.slice(0, 20));
  }
  ok("纯文本/其它代码块：不重试");
}

// ---- [8] 有合法块 + 另有坏块：不重试（否则会出重复面板） --------------------
{
  const text = fence('[{"title":"题","options":["甲","乙"]}]') + "\n\n" + fence('[{"title":"坏","options":[{"title":"甲"},"乙"]}]');
  const info = inspectChoices(text);
  assert.equal(info.validBlocks, 1);
  assert.equal(info.broken, true);
  assert.equal(detectFailure(text), null, "已有可渲染面板时不再重试");
  ok("合法块 + 坏块：不重试");
}

// ---- [9] 重试提示包含关键约束 --------------------------------------------
{
  const hint = retryHint("原因示例");
  for (const must of ["```choices", "label", "不要重复正文", "原因示例"]) {
    assert.ok(hint.includes(must), "重试提示缺少：" + must);
  }
  assert.ok(!hint.includes("title\":\"选项A\""), "不应把 label 写成 title");
  ok("重试提示：含开围栏、label、不许重复正文");
}

// ---- [10] 会话读取辅助 ----------------------------------------------------
{
  const entries = [
    { type: "message", id: "e1", message: { role: "user", content: "问题一" } },
    { type: "message", id: "e2", message: { role: "assistant", content: [{ type: "text", text: "回答" }] } },
    { type: "custom", id: "e3", data: {} },
    { type: "message", id: "e4", message: { role: "user", content: [{ type: "text", text: "问题二" }] } },
  ];
  assert.equal(lastAssistantText(entries), "回答", "应取最后一条 assistant");
  assert.equal(turnKey(entries), "e4", "回合 key 应取最后一条 user 条目 id");
  assert.equal(textOfContent([{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(textOfContent(undefined), "");
  ok("会话读取：最后 assistant / 回合 key / content 拼接");
}


// ---- [11] 设置同步：问答方式 = manual 时不重试 ---------------------------
{
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mpi-qa-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ qaMode: "manual" }));
  assert.equal(qaModeIsManual(file), true, "manual 应停用自动重试");
  // mtime 变化后立刻跟着变（设置一改就生效，不等重启）
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(file, JSON.stringify({ qaMode: "inline" }));
  assert.equal(qaModeIsManual(file), false, "切回 inline 应恢复重试");
  assert.equal(qaModeIsManual(join(dir, "missing.json")), false, "配置缺失时按默认 inline");
  ok("设置同步：manual 停用 / inline 恢复 / 缺失按默认");
}

// ---- [12] 隐藏指令用完后从上下文摘掉（不删会话文件） ---------------------
{
  const plainAssistant = { type: "message", id: "a1", message: { role: "assistant", content: "回答" } };
  const retryMsg = (id) => ({ type: "custom_message", id, customType: "mpi-choice-retry", content: "修正指令", display: false });
  const user = { type: "message", id: "u1", message: { role: "user", content: "问题" } };

  const calls = [];
  const sm = { getEntries: () => [user, retryMsg("r1"), plainAssistant], appendContextEdit: (id, repl) => calls.push([id, repl]) };

  // 指令之后已有 assistant → 这一轮用过了 → 摘掉
  assert.equal(clearUsedRetryInstructions(sm), 1);
  assert.deepEqual(calls, [["r1", null]], "应以 replacement=null 摘除，而不是删文件");
  // 同一进程重复调用不重复摘（幂等）
  assert.equal(clearUsedRetryInstructions(sm), 0);
  ok("上下文清理：用过的指令摘除一次且幂等");

  // 指令刚注入、还没有 assistant → 必须保留（否则重试轮看不到指令）
  const sm2 = { getEntries: () => [user, retryMsg("r2")], appendContextEdit: () => calls.push(["BAD"]) };
  assert.equal(clearUsedRetryInstructions(sm2), 0);
  assert.equal(calls.filter(([x]) => x === "BAD").length, 0, "未使用的指令不能被摘掉");
  // 非重试类型的 custom 消息不动
  const sm3 = { getEntries: () => [user, { type: "custom_message", id: "x", customType: "other" }, plainAssistant], appendContextEdit: () => calls.push(["OTHER"]) };
  assert.equal(clearUsedRetryInstructions(sm3), 0);
  ok("上下文清理：未使用的保留、其它 custom 消息不动");
}

console.log(`
choices 自动重试测试通过：${n} 项`);
