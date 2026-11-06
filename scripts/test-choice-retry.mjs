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
import fs from "node:fs";
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
  // 超过 6 题改成「不判非法」（改于 2026-11-06）：渲染端是**截断成 6 题 + 写明被截掉**，
  // 旧块已经画面板了；这里判非法只会白重试一轮，然后同一问题出两个可点面板。
  assert.equal(
    isValidChoicesBody(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ title: "q" + i, options: ["a", "b"] })))),
    true,
    "超过 6 题不判非法（与渲染端的截断保持一致）",
  );
  ok("结构校验：label/title、单选项、空数组、超 6 题");
}

// ---- [3] 裸英文双引号：修复链能救回 → 不重试（改于 2026-10-26） ----------------
// 旧行为：严格 JSON 判坏 → 重试；但渲染端本来就能修复它 → 重试后再出一份面板
// = 同一问题两个可点面板。现在两头用同一判据：**能渲染就不重试**。
{
  const text = fence('[{"title":"用哪个？","options":["方案 "甲" 好","方案乙"]}]');
  const info = inspectChoices(text);
  assert.equal(info.fenced, true);
  assert.equal(info.validBlocks, 1, "修复链应能把裸引号救回来");
  assert.equal(info.broken, false);
  assert.equal(detectFailure(text), null, "能渲染的块不能触发重试（否则面板会出两份）");
  ok("裸引号块：修复链救回 → 不重试（防重复面板）");
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

// ---- [11] 修复链 parity：判「要不要重试」必须与「能不能渲染」一致 --------------
// 旧行为：这里只做严格 JSON.parse，渲染端却有修复链 → 同一块被判非法（触发重试）
// 却照样画成面板 → 一次输出出两个可点面板（2026-10-26 thinkbook16p 会话实证）。
{
  const rb = await import("../src/renderer/src/lib/choice-block.ts");
  const rendersAsPanel = (body) => rb.splitChoiceSegments(fence(body)).some((s) => s.kind === "choice");
  const corpus = [
    // 本次事故的坏法：detail 里的裸英文双引号包中文
    '[{"title":"区域 ID 的稳定策略","options":[{"label":"锚点派生","detail":"把"平台本来就有真标高"这件事错过"},{"label":"编号固定"}]}]',
    // 尾逗号
    '[{"title":"题","options":["甲","乙",]},]',
    // 少了结尾括号
    '[{"title":"题","options":["甲","乙"]}',
    // options 里丢了 {} 的裸 label 对
    '[{"title":"题","options":["label":"甲","detail":"说明","label":"乙","detail":"说明2"]}]',
    // ④ 键名漏开头的引号（2026-11-06 新补，两边必须同样认为能渲染）
    '[{"title":"题","options":[{"label":"甲"},{"label":"乙",detail":"说明"}]}]',
    '[{"title":"题","options":[{label:"甲"},{label:"乙"}]}]',
    // ⑤ 无键成员：数组提前收尾 / 对象里多一段
    '[{"title":"题","options":["甲","乙"],{"label":"丙","detail":"说明"}]}]',
    '[{"title":"题",{"x":1},"options":["甲","乙"]}]',
    // ⑥ 顶层漏了 []
    '{"title":"题","options":["甲","乙"]}',
    '{"title":"甲题","options":["1","2"]},{"title":"乙题","options":["3","4"]}',
    '{"title":"题","options":["甲","乙"]',
    // ⑦ 逐题兜底：中间一题坏掉，其余仍该出面版（也绝不能去重试）
    '[{"title":"甲题","options":["1","2"]},{"title":乙题,"options":["3","4"]},{"title":"丙题","options":["5","6"]}]',
    // 正常块
    '[{"title":"题","options":["甲","乙"]}]',
  ];
  for (const body of corpus) {
    const panel = rendersAsPanel(body);
    const info = inspectChoices(fence(body));
    assert.equal(info.validBlocks > 0, panel, "判定与渲染的结论必须一致：" + body.slice(0, 40));
    assert.equal(panel, true, "这些块都应能渲染：" + body.slice(0, 40));
    assert.equal(detectFailure(fence(body)), null, "能渲染的块绝不能触发重试：" + body.slice(0, 40));
  }
  ok("修复链 parity：能渲染 ⇔ 不重试（七类坏法逐个对账）");

  // 真救不回来的块：两边都判非法，且报错位置要进提示词
  const broken = '[{"title":"题" "options":["甲","乙"]}]';
  assert.equal(rendersAsPanel(broken), false, "缺逗号的块渲染端也不该出面板");
  const fail = detectFailure(fence(broken));
  assert.ok(fail, "真坏块仍要触发重试");
  assert.match(fail.reason, /position|line \d+|unexpected/i, "重试原因应带上解析错误位置");
  // 占位符式的正文（模型真在写草稿）：不能因为「能补标点」就硬拼个面板出来
  const draft = "[{下一步怎么走…}, {推不推…}]";
  assert.equal(rendersAsPanel(draft), false, "没有 title/options 的草稿不是选择题");
  assert.ok(detectFailure(fence(draft)), "草稿块照旧触发重试");
  ok("真坏块：仍重试，且原因带 JSON 错误位置");
}

// ---- [13] 围栏写法容错 + ```json 的回喂（2026-11-06）-------------------------
// 放宽后的两条线：① 标签里含 choices → 能渲染，绝不重试；② 不含 choices（```json）→
// 不渲染，但只有「它确实是整条回答的末尾且正文严格合法」才回喂模型重写（文档示例不触发）。
{
  const rb = await import("../src/renderer/src/lib/choice-block.ts");
  const body = '[{"title":"题","options":["甲","乙"]}]';
  const rendersAsPanel = (text) => rb.splitChoiceSegments(text).some((s) => s.kind === "choice");

  // ① 四种新接受的写法：两端结论都是「能渲染 + 不重试」
  for (const [name, text] of [
    ["choices json", "```choices json\n" + body + "\n```"],
    ["浪加号闭合", "```choices\n" + body + "\n~~~"],
    ["列表项里", "- ```choices\n" + body + "\n  ```"],
    ["正文与围栏同行", "```choices " + body],
  ]) {
    assert.equal(rendersAsPanel(text), true, `渲染端应画面板：${name}`);
    assert.equal(detectFailure(text), null, `能画面板就绝不能重试：${name}`);
  }

  // ② ```json：渲染端不画；位置在末尾才回喂
  const jsonTail = "先说明一下方案：\n\n```json\n" + body + "\n```";
  assert.equal(rendersAsPanel(jsonTail), false, "```json 不画面板（保险丝）");
  const fail = detectFailure(jsonTail);
  assert.ok(fail, "末尾的 ```json 选择题该回喂重写");
  assert.match(fail.reason, /json/, "原因要说清是标签写错了");

  // 文档里的 JSON 示例：后面还跟着解说文字 → 不动它（这正是用户担心的误伤）
  const docExample =
    "格式如下：\n\n```json\n" + body + "\n```\n\n上面就是一个合法的选择题写法，客户端会渲染成面板。";
  assert.equal(detectFailure(docExample), null, "引用示例不该触发重试");
  // ```json 但正文本身不是合法选择题 → 也不重试
  assert.equal(detectFailure("随便聊聊\n\n```json\n{\"a\":1}\n```"), null, "普通 JSON 不算选择题");
  ok("围栏容错四写法均不重试；```json 只在「末尾且严格合法」时回喂");
}

// ---- [12] 两份实现的源码对账（注释除外必须逐字一致）------------------------------
// 背面的事故已经踩过两次：只改渲染端不改这份拷贝 → 同一输出「那边能渲染、
// 这边判非法」→ 白重试一轮 + 两个面板。行为语料只能覆盖想到的坏法，这一条直接防「改了没同步」。
{
  const RB = new URL("../src/renderer/src/lib/choice-block.ts", import.meta.url);
  const EX = new URL("../src/main/mpi-choice-retry-ext.ts", import.meta.url);
  // 网页版客户端自己有一份移植件（同语言），一并纳入对账。
  const TARGETS = [
    ["主进程重试扩展", EX],
    ["PWA 客户端", new URL("../mobile/pwa/src/lib/choice-block.ts", import.meta.url)],
  ];
  /** 取顶层函数体，剪掉注释与缩进（两边写同一个字符允许 '"' 或 '\"' 两种写法）。 */
  const shared = (file, name) => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const i = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    if (i < 0) return null;
    let j = i;
    while (j < lines.length && lines[j] !== "}") j++;
    return lines
      .slice(i, j + 1)
      .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
      .map((l) => l.trim().replace(/\\"/g, '"'))
      .join("\n");
  };
  // 必须是同一份算法的函数（新增修复时把名字跟着加进来）。
  const names = [
    "sliceFirstJson",
    "escapeStrayQuotes",
    "closeOpenBrackets",
    "dropTrailingCommas",
    "peekKey",
    "wrapBareLabelPairs",
    "skipBalanced",
    "quoteBareKeys",
    "repairStrayMembers",
    "questionStarts",
    "splitQuestionChunks",
    "repairChain",
    "repairCandidates",
  ];
  for (const [label, target] of TARGETS) {
    for (const name of names) {
      const a = shared(RB, name);
      const b = shared(target, name);
      assert.ok(a !== null && b !== null, `${label} 里也该有 ${name}（缺就是漏搬）`);
      assert.equal(b, a, `${name} 在「桌面端 vs ${label}」两份实现不一致——改了一边就得同步另一边`);
    }
  }
  ok(`多份实现对账：${names.length} 个函数 × ${TARGETS.length} 份副本逐字一致`);
}

console.log(`
choices 自动重试测试通过：${n} 项`);
