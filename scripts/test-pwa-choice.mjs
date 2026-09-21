/**
 * 手机端 choices 面板逻辑测试（mobile/pwa/src/lib/choice-block.ts）。
 *
 *   1. parseChoiceBlockData — 合法/非法形状（题数、选项数、title、detail、去重）
 *   2. withChoiceSegments — 流式原样 / 闭合升级面板 / 粘行闭合还原尾文 /
 *      漏写闭合 / 非法降级代码块+提示 / 非 choices 围栏不受影响
 *   3. buildChoiceReplyText + parseChoiceReply — 组合回复契约（zh/en、其它、
 *      部分回答/标题不符 → null）
 *   4. deriveChoicePanelState — pending / answered / superseded / 未知消息
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { parseChoiceBlockData, withChoiceSegments, buildChoiceReplyText, parseChoiceReply, deriveChoicePanelState } = await import("../mobile/pwa/src/lib/choice-block.ts");
const { parseSegments } = await import("../mobile/pwa/src/lib/markdown-lite.ts");

// ---- 1. parseChoiceBlockData -------------------------------------------------
{
  const ok = parseChoiceBlockData('[{"title":"用什么方案？","options":["方案甲（推荐）","方案乙"]}]');
  assert.ok(ok, "单题字符串选项合法");
  assert.equal(ok.questions.length, 1);
  assert.deepEqual(ok.questions[0].options.map((o) => o.label), ["方案甲（推荐）", "方案乙"]);

  const detail = parseChoiceBlockData('[{"title":"Q","options":[{"label":"A","detail":"更稳"},{"label":"B"}]}]');
  assert.equal(detail.questions[0].options[0].detail, "更稳");
  assert.equal(detail.questions[0].options[1].detail, undefined);

  // {questions:[...]} 包装形态也接受（与桌面端一致）
  const wrapped = parseChoiceBlockData('{"questions":[{"title":"Q","options":["A","B"]}]}');
  assert.ok(wrapped && wrapped.questions.length === 1, "questions 包装合法");

  // 重复 label 去重后不足 2 个 → 非法
  assert.equal(parseChoiceBlockData('[{"title":"Q","options":["A","A"]}]'), null, "去重后 <2 选项非法");
  assert.equal(parseChoiceBlockData('[{"title":"","options":["A","B"]}]'), null, "空 title 非法");
  assert.equal(parseChoiceBlockData('[{"title":"Q","options":["A"]}]'), null, "1 个选项非法");
  const seven = ["A", "B", "C", "D", "E", "F", "G"];
  assert.equal(parseChoiceBlockData(JSON.stringify([{ title: "Q", options: seven }])), null, "7 个选项非法");
  assert.equal(parseChoiceBlockData("[]"), null, "空数组非法");
  const many = Array.from({ length: 7 }, (_, i) => ({ title: `Q${i}`, options: ["A", "B"] }));
  assert.equal(parseChoiceBlockData(JSON.stringify(many)), null, "7 题非法");
  assert.equal(parseChoiceBlockData("not json"), null, "非 JSON 非法");

  console.log("ok 1 - parseChoiceBlockData: 合法/非法形状");
}

// ---- 2. withChoiceSegments ----------------------------------------------------
const FENCE_BODY = '[{"title":"用什么方案？","options":["方案甲（推荐）","方案乙"]},{"title":"要不要加测试？","options":["要","不要"]}]';

{
  // 正常闭合：正文 + choices 围栏 + 尾文 → [text, choice, text]
  const text = `先说结论。\n\n\`\`\`choices\n${FENCE_BODY}\n\`\`\`\n\n选完我就开工。`;
  const segs = parseSegments(text);
  assert.equal(segs.length, 3, "parseSegments 切出三段");
  assert.equal(segs[1].type, "code");
  assert.equal(segs[1].lang, "choices");

  const items = withChoiceSegments(segs, true);
  assert.deepEqual(items.map((i) => i.kind), ["text", "choice", "text"], "闭合围栏升级为面板，前后文本保留");
  assert.equal(items[1].data.questions.length, 2);
  assert.equal(items[1].data.questions[0].title, "用什么方案？");

  // 流式中（finalized=false）：原样返回，围栏保持代码块
  const streaming = withChoiceSegments(segs, false);
  assert.deepEqual(streaming.map((i) => i.kind), ["text", "code", "text"], "流式中不升级面板");
  assert.equal(streaming[1].lang, "choices");

  console.log("ok 2 - withChoiceSegments: 闭合围栏升级 / 流式原样");
}

{
  // 粘行闭合：模型把 ``` 粘在 JSON 行尾（deepseek 系常见）→ 面板 + 尾文还原
  const text = `\`\`\`choices\n${FENCE_BODY}\`\`\`\n后续正文在这里。`;
  const segs = parseSegments(text);
  assert.equal(segs.length, 1, "粘行闭合时 parseSegments 只剩一个未闭合代码段");
  assert.equal(segs[0].closed, false);

  const items = withChoiceSegments(segs, true);
  assert.deepEqual(items.map((i) => i.kind), ["choice", "text"], "粘行闭合：面板 + 尾文还原");
  assert.equal(items[1].text.trim(), "后续正文在这里。");
  assert.equal(items[0].data.questions.length, 2);

  // 同一文本流式中 → 保持未闭合代码块（不提前解析）
  const streaming = withChoiceSegments(segs, false);
  assert.deepEqual(streaming.map((i) => i.kind), ["code"]);

  console.log("ok 3 - withChoiceSegments: 粘行闭合容错 + 尾文还原");
}

{
  // 漏写闭合围栏：整体当正文（合法 JSON 才采纳）
  const text = `\`\`\`choices\n${FENCE_BODY}`;
  const segs = parseSegments(text);
  assert.equal(segs[0].closed, false);
  const items = withChoiceSegments(segs, true);
  assert.deepEqual(items.map((i) => i.kind), ["choice"], "漏闭合但 JSON 合法 → 面板");

  // 漏闭合且 JSON 非法 → 降级代码块 + 提示
  const bad = parseSegments("\`\`\`choices\n这不是JSON");
  const badItems = withChoiceSegments(bad, true);
  assert.equal(badItems[0].kind, "code");
  assert.equal(badItems[0].choiceWarn, true, "非法 choices 围栏带降级提示");

  // 已闭合但 JSON 尾部挂垃圾（模型吐了特殊 token）→ sliceFirstJson 救回
  const garbage = parseSegments(`\`\`\`choices\n${FENCE_BODY}\n<|end|>\n\`\`\``);
  const gItems = withChoiceSegments(garbage, true);
  assert.equal(gItems[0].kind, "choice", "闭合围栏内尾部垃圾可容错解析");

  // 非 choices 代码块不受影响
  const py = parseSegments("说明\n\`\`\`python\nprint(1)\n\`\`\`");
  const pyItems = withChoiceSegments(py, true);
  assert.deepEqual(pyItems.map((i) => i.kind), ["text", "code"]);
  assert.equal(pyItems[1].choiceWarn, undefined, "普通代码块不带 choices 提示");

  console.log("ok 4 - withChoiceSegments: 漏闭合 / 尾部垃圾 / 非法降级 / 非 choices 不受影响");
}

// ---- 3. buildChoiceReplyText + parseChoiceReply --------------------------------
const QUESTIONS = [
  { title: "用什么方案？", options: [{ label: "方案甲（推荐）" }, { label: "方案乙" }] },
  { title: "要不要加测试？", options: [{ label: "要" }, { label: "不要" }] },
];

{
  const reply = buildChoiceReplyText(QUESTIONS, [
    { kind: "option", label: "方案甲（推荐）" },
    { kind: "other", text: "先不加，后面补" },
  ], "zh");
  assert.equal(reply, "我的选择：\n1. 用什么方案？ → 方案甲（推荐）\n2. 要不要加测试？ → 其它：先不加，后面补");

  const parsed = parseChoiceReply(reply, QUESTIONS);
  assert.ok(parsed, "组合回复可解析回答案");
  assert.deepEqual(parsed[0], { kind: "option", label: "方案甲（推荐）" });
  assert.deepEqual(parsed[1], { kind: "other", text: "先不加，后面补" });

  // en header 也认（桌面端英文模式发的回复在手机上同样能推导状态）
  const en = buildChoiceReplyText(QUESTIONS, [{ kind: "option", label: "方案乙" }, null], "en");
  assert.ok(en.startsWith("My choices:"), "en 头");
  assert.equal(parseChoiceReply(en, QUESTIONS), null, "含未选题的回复不算完整组合回复");

  // 普通用户消息 → null（面板将被推导为 superseded）
  assert.equal(parseChoiceReply("好的，用方案甲吧", QUESTIONS), null);
  // 部分回答 / 标题不符 → null
  assert.equal(parseChoiceReply("我的选择：\n1. 用什么方案？ → 方案甲（推荐）", QUESTIONS), null, "缺题不算");
  assert.equal(parseChoiceReply("我的选择：\n1. 别的题？ → 方案乙\n2. 要不要加测试？ → 要", QUESTIONS), null, "标题不符不算");

  console.log("ok 5 - build/parseChoiceReply: 契约往返 + 拒绝普通回复");
}

// ---- 4. deriveChoicePanelState --------------------------------------------------
{
  const data = { questions: QUESTIONS };
  const reply = buildChoiceReplyText(QUESTIONS, [{ kind: "option", label: "方案甲（推荐）" }, { kind: "option", label: "要" }], "zh");

  // pending：后面还没有用户消息
  assert.deepEqual(deriveChoicePanelState([{ id: "a1", role: "assistant", blocks: [] }], "a1", data), { kind: "pending" });

  // answered：下一条用户消息是组合回复（含乐观回显的 pending 占位——只看文本）
  const answered = deriveChoicePanelState(
    [
      { id: "a1", role: "assistant", blocks: [{ type: "text", text: "…choices…" }] },
      { id: "u1", role: "user", blocks: [{ type: "text", text: reply }] },
    ],
    "a1",
    data,
  );
  assert.equal(answered.kind, "answered");
  assert.deepEqual(answered.answers[0], { kind: "option", label: "方案甲（推荐）" });

  // superseded：用户改用打字回答
  const sup = deriveChoicePanelState(
    [
      { id: "a1", role: "assistant", blocks: [] },
      { id: "u1", role: "user", blocks: [{ type: "text", text: "直接选方案甲" }] },
    ],
    "a1",
    data,
  );
  assert.deepEqual(sup, { kind: "superseded" });

  // 未知消息 id → pending（resync 后旧面板引用失效时不炸）
  assert.deepEqual(deriveChoicePanelState([{ id: "x", role: "user", blocks: [] }], "a1", data), { kind: "pending" });

  console.log("ok 6 - deriveChoicePanelState: pending / answered / superseded");
}

console.log("pwa choice tests passed");
