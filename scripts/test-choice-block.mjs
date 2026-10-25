import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const cb = await import("../src/renderer/src/lib/choice-block.ts");
const search = await import("../src/renderer/src/lib/chat-search.ts");

const FENCE_OPEN = "```choices";
const fence = (body) => `${FENCE_OPEN}\n${body}\n\`\`\``;

// --- splitChoiceSegments -----------------------------------------------------

// Fast path: no marker → single md segment with the ORIGINAL string identity.
{
  const plain = "hello\nworld";
  assert.deepEqual(cb.splitChoiceSegments(plain), [{ kind: "md", text: plain }]);
}

// Valid fence between prose segments.
{
  const body = JSON.stringify([
    { title: "用什么方案？", options: ["方案甲（推荐）", "方案乙"] },
    { title: "第二个问题？", options: [{ label: "x", detail: "细节说明" }, "y"] },
  ]);
  const text = `前言段落\n\n${fence(body)}\n\n后记段落`;
  const segs = cb.splitChoiceSegments(text);
  assert.equal(segs.length, 3);
  // Blank lines around the fence are preserved in the surrounding segments.
  assert.deepEqual(segs[0], { kind: "md", text: "前言段落\n" });
  assert.equal(segs[1].kind, "choice");
  assert.deepEqual(segs[1].data.questions, [
    { title: "用什么方案？", options: [{ label: "方案甲（推荐）" }, { label: "方案乙" }] },
    { title: "第二个问题？", options: [{ label: "x", detail: "细节说明" }, { label: "y" }] },
  ]);
  assert.deepEqual(segs[2], { kind: "md", text: "\n后记段落" });
}

// Invalid JSON body → code segment carrying the original fence text.
{
  const text = `前\n${fence("{not json")}\n后`;
  const segs = cb.splitChoiceSegments(text);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0], { kind: "md", text: "前" });
  assert.equal(segs[1].kind, "code");
  assert.ok(segs[1].text.startsWith(FENCE_OPEN) && segs[1].text.endsWith("```"));
  assert.deepEqual(segs[2], { kind: "md", text: "后" });
}

// info string 写歪（2026-10-12：```choices> 曾整块静默降级成代码块，既无面板也无提示）。
{
  const body = JSON.stringify([{ title: "怎么落地？", options: ["做 A", "做 B"] }]);
  const fenceWith = (info) => "```" + info + "\n" + body + "\n```";

  // ① 精确档 + 尾随噪声：升级成面板，并把笔误形态带在 info 上（诊断日志据此统计）。
  for (const info of ["choices>", "choices:", "choices\""]) {
    const panel = cb.splitChoiceSegments(`问：\n${fenceWith(info)}\n`).find((s) => s.kind === "choice");
    assert.ok(panel, `info="${info}" 应渲染成面板`);
    assert.equal(panel.info, info, "笔误形态要能被诊断日志看到");
  }
  // 大小写与尾随空白等价于标准写法：升级但不带 info（不制造诊断噪声）。
  for (const info of ["Choices", "choices "]) {
    const panel = cb.splitChoiceSegments(fenceWith(info)).find((s) => s.kind === "choice");
    assert.ok(panel, `info="${info}" 应等价于标准 choices`);
    assert.equal(panel.info, undefined);
  }
  // 标准写法也不带 info。
  assert.equal(cb.splitChoiceSegments(fence(body)).find((s) => s.kind === "choice").info, undefined);

  // ② 疑似档（标签被写歪成另一个词）：正文严格合法才升级。
  for (const info of ["choicesjson", "choices_v2"]) {
    const segs = cb.splitChoiceSegments(fenceWith(info));
    const panel = segs.find((s) => s.kind === "choice");
    assert.ok(panel, `info="${info}" + 合法正文应升级`);
    assert.equal(panel.info, info);
  }
  // 疑似档 + 正文非法 → 维持原行为：整段普通文本，不弹提示、不吞正文。
  const badSegs = cb.splitChoiceSegments("```choicesjson\n{oops\n```");
  assert.ok(!badSegs.some((s) => s.kind === "choice" || s.kind === "code"), "疑似档 + 非法正文不该产生面板或告警块");
  assert.ok(badSegs[0].text.includes("choicesjson"), "原文必须原样保留");

  // ③ 其它语言标签即使正文合法也不升级（别把普通 json 代码块吞成面板）。
  const other = cb.splitChoiceSegments("```json\n" + body + "\n```");
  assert.equal(other.length, 1);
  assert.equal(other[0].kind, "md");
}

// A choices example QUOTED inside another code fence must not activate.
{
  const inner = fence(JSON.stringify([{ title: "q", options: ["a", "b"] }]));
  const text = `示例如下：\n\n\`\`\`markdown\n${inner}\n\`\`\`\n\n结束`;
  const segs = cb.splitChoiceSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "md");
  assert.equal(segs[0].text, text);
}

// Unterminated fence → plain text.
{
  const text = `abc\n${FENCE_OPEN}\n{"title":"q","options":["a","b"]}`;
  const segs = cb.splitChoiceSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "md");
}

// 粘行闭合（模型把闭合反引号贴在 JSON 同一行末尾，deepseek 系常见）——仍应识别为 choices。
{
  const body = JSON.stringify([{ title: "q", options: ["a", "b"] }]);
  const text = `前言\n${FENCE_OPEN}\n${body}\`\`\` `;
  const segs = cb.splitChoiceSegments(text);
  assert.deepEqual(segs.map((s) => s.kind), ["md", "choice"]);
  assert.deepEqual(segs[1].data.questions, [{ title: "q", options: [{ label: "a" }, { label: "b" }] }]);
}

// 粘行闭合 + 后续还有正文：后文保留为普通 markdown（不被吞进围栏）。
{
  const body = JSON.stringify([{ title: "q", options: ["a", "b"] }]);
  const text = `${FENCE_OPEN}\n${body}\`\`\`\n补充说明`;
  const segs = cb.splitChoiceSegments(text);
  assert.deepEqual(segs.map((s) => s.kind), ["choice", "md"]);
  assert.equal(segs[1].text, "补充说明");
}

// 多行 JSON + 末行粘行闭合。
{
  const body = `[\n  {\n    "title": "q",\n    "options": ["a", "b"]\n  }\n]`;
  const text = `前\n${FENCE_OPEN}\n${body}\`\`\` `;
  const segs = cb.splitChoiceSegments(text);
  assert.deepEqual(segs.map((s) => s.kind), ["md", "choice"]);
}

// 干脆忘了闭合：围栏一直到文本末尾（JSON 合法）→ 容错成 choices。
{
  const body = JSON.stringify([{ title: "q", options: ["a", "b"] }]);
  const text = `前\n${FENCE_OPEN}\n${body}`;
  const segs = cb.splitChoiceSegments(text);
  assert.deepEqual(segs.map((s) => s.kind), ["md", "choice"]);
}

// 忘了闭合且正文不是合法 choices JSON → 保持原样（普通文本，渲染成代码块）。
{
  const text = `前\n${FENCE_OPEN}\n{"title":"q","options":["只有一个"]}\n后记`;
  const segs = cb.splitChoiceSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "md");
  assert.equal(segs[0].text, text);
}

// 回归：模型把闭合围栏吐成特殊 token（尾部挂非 JSON 垃圾）→ 仍要认成面板。
// 实测故障：`[{"a"}]` 后面跟三行 `</XXX_SPECIAL_TOKEN>` 类控制标记，严格 parse 必失败。
{
  const body = JSON.stringify([{ title: "q", options: ["a", "b"] }]);
  const text = `前言\n${FENCE_OPEN}\n${body}\n</XyZ_SPECIAL_TOKEN_1>\n</XyZ_SPECIAL_TOKEN_2>`;
  const segs = cb.splitChoiceSegments(text);
  assert.deepEqual(segs.map((s) => s.kind), ["md", "choice"]);
  assert.equal(segs[1].data.questions[0].title, "q");
}

// 同上，但闭合围栏还在（垃圾污染的是正文尾部）→ 一样要认。
{
  const body = JSON.stringify([{ title: "q", options: ["a", "b"] }]);
  const text = `前\n${fence(`${body}\n</XyZ_SPECIAL_TOKEN>` )}\n后`;
  const segs = cb.splitChoiceSegments(text);
  assert.deepEqual(segs.map((s) => s.kind), ["md", "choice", "md"]);
}

// 垃圾 + JSON 本身非法 → 仍不认（截第一个 JSON 不得变成「能截就认」）。
{
  const text = `前\n${FENCE_OPEN}\n[{oops}]\n</XyZ_SPECIAL_TOKEN>\n后记`;
  const segs = cb.splitChoiceSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "md");
}

// 粘行闭合但 JSON 非法 → 降级为 code 段（容错不得误吞）。
{
  const text = `前\n${FENCE_OPEN}\n[{oops}]\`\`\` `;
  const segs = cb.splitChoiceSegments(text);
  assert.deepEqual(segs.map((s) => s.kind), ["md", "code"]);
}

// 反引号数不匹配（4 开 3 闭）→ 容错接受。
{
  const body = JSON.stringify([{ title: "q", options: ["a", "b"] }]);
  const text = `前\n\`\`\`\`choices\n${body}\n\`\`\` `;
  const segs = cb.splitChoiceSegments(text);
  assert.deepEqual(segs.map((s) => s.kind), ["md", "choice"]);
}

// A choices example inside a LONGER (4-backtick) fence stays inert — the
// closer must be at least as long as the opener (CommonMark).
{
  const inner = fence(JSON.stringify([{ title: "q", options: ["a", "b"] }]));
  const text = `\`\`\`\`markdown\n${inner}\nmore text\n\`\`\`\``;
  const segs = cb.splitChoiceSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "md");
  assert.equal(segs[0].text, text);
}

// Multiple fences in one message.
{
  const mk = (t) => fence(JSON.stringify([{ title: t, options: ["a", "b"] }]));
  const text = `${mk("Q1")}\n中\n${mk("Q2")}`;
  const segs = cb.splitChoiceSegments(text);
  assert.deepEqual(segs.map((s) => s.kind), ["choice", "md", "choice"]);
}

// Validation limits —— 超限不再整块判非法，改成「截断渲染 + clamped 计数」。
{
  const q = (title, options) => JSON.stringify([{ title, options }]);
  assert.equal(cb.parseChoiceBlockData(q("t", ["a"])), null); // <2 options → 这题留不下来
  assert.equal(cb.parseChoiceBlockData(q("", ["a", "b"])), null); // empty title
  const tooManyOptions = cb.parseChoiceBlockData(q("t", ["a", "b", "c", "d", "e", "f", "g"]));
  assert.equal(tooManyOptions.questions[0].options.length, 6);
  assert.deepEqual(tooManyOptions.clamped, { questions: 0, options: 1 });
  const many = cb.parseChoiceBlockData(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, options: ["a", "b"] }))));
  assert.equal(many.questions.length, 6);
  assert.deepEqual(many.clamped, { questions: 1, options: 0 });
  const minimal = cb.parseChoiceBlockData(q("t", ["a", "b"]));
  assert.ok(minimal);
  assert.equal(minimal.clamped, undefined); // 未截断 → 不带 clamped（面板下方不加提示）
  // {questions:[...]} wrapper form is accepted too.
  assert.ok(cb.parseChoiceBlockData(JSON.stringify({ questions: [{ title: "t", options: ["a", "b"] }] })));
}

// --- JSON 修复链（2026-10 对全部历史会话盘点出的 5 类失败形态，文本已合成化） ---
// 三类可修：① 字符串里夹未转义的英文双引号；② 结尾括号被写短；③ options 里丢了 {}
// 包裹的裸 "label" 对。修回来的结果必须与手写 JSON 等价（不能修出乱内容）。
{
  const withFence = (body) => `前\n${FENCE_OPEN}\n${body}\n\`\`\`\n后`;

  // ① 中文串里的英文双引号（严格 parse 必挂）
  {
    const body = `[{"title":"选哪个？","options":[{"label":"把"类型 vs 路由"的分工写死"},{"label":"先不定"}]}]`;
    const segs = cb.splitChoiceSegments(withFence(body));
    assert.deepEqual(segs.map((s) => s.kind), ["md", "choice", "md"]);
    assert.equal(segs[1].repaired, true);
    assert.deepEqual(
      segs[1].data.questions[0].options.map((o) => o.label),
      ['把"类型 vs 路由"的分工写死', "先不定"],
    );
  }

  // ② 结尾少一个 }（模型把 JSON 写短了）
  {
    const body = `[{"title":"用哪个改法","options":[{"label":"A"},{"label":"B"},{"label":"C"}]`;
    const segs = cb.splitChoiceSegments(withFence(body));
    assert.deepEqual(segs.map((s) => s.kind), ["md", "choice", "md"]);
    assert.equal(segs[1].repaired, true);
    assert.deepEqual(segs[1].data.questions[0].options.map((o) => o.label), ["A", "B", "C"]);
  }

  // ③ options 里丢了 {} 包裹的裸 label 对（且不跟 detail）
  {
    const body = `[{"title":"午饭怎么安排？","options":[{"label":"楼外楼","detail":"需订位"},"label":"沿途简餐","label":"自带干粮"]}]`;
    const segs = cb.splitChoiceSegments(withFence(body));
    assert.deepEqual(segs.map((s) => s.kind), ["md", "choice", "md"]);
    assert.equal(segs[1].repaired, true);
    assert.deepEqual(segs[1].data.questions[0].options.map((o) => o.label), ["楼外楼", "沿途简餐", "自带干粮"]);
  }

  // 修复链不得误伤：合法 JSON 不走修复（repaired 不置位）
  {
    const body = JSON.stringify([{ title: "q", options: [{ label: "a", detail: '含 "引号" 的说明' }, "b"] }]);
    const segs = cb.splitChoiceSegments(withFence(body));
    assert.equal(segs[1].kind, "choice");
    assert.equal(segs[1].repaired, undefined);
    assert.equal(segs[1].data.questions[0].options[0].detail, '含 "引号" 的说明');
  }

  // 修不出来 → 降级代码块，并带上具体原因与原文（供 UI 提示 + 诊断日志）
  {
    const segs = cb.splitChoiceSegments(withFence(`[{oops}]`));
    assert.deepEqual(segs.map((s) => s.kind), ["md", "code", "md"]);
    assert.equal(segs[1].reason, "syntax");
    assert.equal(segs[1].raw, "[{oops}]");
  }
  {
    // JSON 能解析但结构不符（每题 options 至少 2 个）→ reason = shape
    const segs = cb.splitChoiceSegments(withFence(`[{"title":"q","options":["只有一个"]}]`));
    assert.deepEqual(segs.map((s) => s.kind), ["md", "code", "md"]);
    assert.equal(segs[1].reason, "shape");
  }
}

// --- reply build/parse round-trip --------------------------------------------

for (const language of ["zh", "en"]) {
  const questions = [
    { title: "用什么方案？", options: [{ label: "方案甲（推荐）" }, { label: "方案乙" }] },
    { title: "第二个问题？", options: [{ label: "x" }, { label: "y" }] },
  ];
  const answers = [
    { kind: "option", label: "方案甲（推荐）" },
    { kind: "other", text: "自定义答案 with spaces" },
  ];
  const text = cb.buildChoiceReplyText(questions, answers, language);
  assert.ok(text.startsWith(language === "zh" ? "我的选择：" : "My choices:"));
  const parsed = cb.parseChoiceReply(text, questions).answers;
  assert.deepEqual(parsed, { 0: answers[0], 1: answers[1] });
}

// parseChoiceReply rejects anything that is not our exact combined reply.
{
  const questions = [{ title: "用什么方案？", options: [{ label: "A" }, { label: "B" }] }];
  assert.equal(cb.parseChoiceReply("随便聊聊", questions), null);
  assert.equal(cb.parseChoiceReply(undefined, questions), null);
  assert.equal(cb.parseChoiceReply("我的选择：\n1. 别的标题 → A", questions), null); // title mismatch
  assert.equal(cb.parseChoiceReply("我的选择：\n1. 用什么方案？ → C", questions), null); // unknown answer
  const zh = cb.buildChoiceReplyText(questions, [{ kind: "option", label: "A" }], "zh");
  assert.equal(cb.parseChoiceReply(zh.replace("→ A", "→ B 和 C"), questions), null); // answer with extra text is rejected
  // en reply parses for zh UI and vice versa (header accepted in both languages).
  const en = cb.buildChoiceReplyText(questions, [{ kind: "option", label: "A" }], "en");
  assert.deepEqual(cb.parseChoiceReply(en, questions).answers, { 0: { kind: "option", label: "A" } });
}

// --- 跳过 / 补充说明（2026-10-25）------------------------------------------
{
  const qs = [
    { title: "方案？", options: [{ label: "A" }, { label: "B" }] },
    { title: "部署？", options: [{ label: "x" }, { label: "y" }] },
    { title: "验收？", options: [{ label: "p" }, { label: "q" }] },
  ];

  for (const lang of ["zh", "en"]) {
    // 选项带补充 + 跳过（省略行）+ 其它带补充
    const t1 = cb.buildChoiceReplyText(
      qs,
      [
        { kind: "option", label: "A", note: "要兼容旧配置" },
        { kind: "skip" },
        { kind: "other", text: "手拷", note: "先应急" },
      ],
      lang,
    );
    const lines = t1.split("\n");
    assert.equal(lines.length, 3, "跳过的题不应输出行（header + 2 题）");
    assert.ok(/补充|note/.test(lines[1]), "选项的补充说明要带在行尾");
    assert.deepEqual(cb.parseChoiceReply(t1, qs).answers, {
      0: { kind: "option", label: "A", note: "要兼容旧配置" },
      1: { kind: "skip" },
      2: { kind: "other", text: "手拷", note: "先应急" },
    });

    // 跳过 + 补充 → 无标题的「补充：…」行；未出现的题按跳过处理
    const t2 = cb.buildChoiceReplyText(qs, [{ kind: "option", label: "B" }, { kind: "skip", note: "这题不适用" }, { kind: "skip" }], lang);
    assert.ok(/^2\. → (补充|Note)/m.test(t2), "跳过 + 补充应输出不带标题的行");
    assert.deepEqual(cb.parseChoiceReply(t2, qs).answers, {
      0: { kind: "option", label: "B" },
      1: { kind: "skip", note: "这题不适用" },
      2: { kind: "skip" },
    });

    // 全部跳过：至少留一行占位，模型不会收到只有标题头的消息
    const t3 = cb.buildChoiceReplyText(qs, [{ kind: "skip" }, { kind: "skip" }, { kind: "skip" }], lang);
    assert.ok(t3.includes("全部跳过") || t3.includes("all skipped"));
    assert.deepEqual(cb.parseChoiceReply(t3, qs).answers, {
      0: { kind: "skip" },
      1: { kind: "skip" },
      2: { kind: "skip" },
    });
  }

  // 手工编辑过的消息：带标题的「已跳过」也认
  assert.deepEqual(cb.parseChoiceReply("我的选择：\n1. 方案？ → 已跳过\n2. 部署？ → x\n3. 验收？ → p", qs).answers, {
    0: { kind: "skip" },
    1: { kind: "option", label: "x" },
    2: { kind: "option", label: "p" },
  });
  // 省略标题但不是补充 → 不是我们的格式（避免吞普通消息）
  assert.equal(cb.parseChoiceReply("我的选择：\n1. → 随便写点什么", qs), null);

  // 整组补充说明：写在最后一题之后，解析成 reply.note（不是任何一题的 note）
  const t5 = cb.buildChoiceReplyText(qs, [{ kind: "option", label: "A" }, { kind: "skip" }, { kind: "skip" }], "zh", "这组问题还缺一个维度");
  assert.ok(/^补充：这组问题还缺一个维度$/m.test(t5), "整组补充应单独一行");
  const r5 = cb.parseChoiceReply(t5, qs);
  assert.equal(r5.note, "这组问题还缺一个维度");
  assert.deepEqual(r5.answers, { 0: { kind: "option", label: "A" }, 1: { kind: "skip" }, 2: { kind: "skip" } });

  // 补充说明在回传侧截断到 200
  const long = "x".repeat(500);
  const t4 = cb.buildChoiceReplyText(qs, [{ kind: "option", label: "A", note: long }, { kind: "skip" }, { kind: "skip" }], "zh");
  const p4 = cb.parseChoiceReply(t4, qs).answers;
  assert.ok(p4[0].note.length <= cb.CHOICE_NOTE_MAX, "补充说明应截断到上限");
}

// --- panel state derivation ---------------------------------------------------

const msgs = (list) => list.map((m, i) => ({ key: `k${i}`, ...m }));

{
  const data = cb.parseChoiceBlockData(JSON.stringify([{ title: "Q？", options: ["a", "b"] }]));
  // No user message after the block → pending.
  assert.deepEqual(cb.deriveChoicePanelState(msgs([{ role: "assistant" }, { role: "assistant" }]), "k1", data), { kind: "pending" });
  // Unknown message key → pending.
  assert.deepEqual(cb.deriveChoicePanelState(msgs([{ role: "user", text: "x" }]), "nope", data), { kind: "pending" });
  // Matching combined reply → answered with ✓ mapping.
  const reply = cb.buildChoiceReplyText(data.questions, [{ kind: "option", label: "a" }], "zh");
  assert.deepEqual(cb.deriveChoicePanelState(msgs([{ role: "assistant" }, { role: "user", text: reply }]), "k0", data), {
    kind: "answered",
    answers: { 0: { kind: "option", label: "a" } },
  });
  // Any other user message → superseded.
  assert.deepEqual(cb.deriveChoicePanelState(msgs([{ role: "assistant" }, { role: "user", text: "我选 a，另外…" }]), "k0", data), { kind: "superseded" });
}

// --- search corpus alignment ---------------------------------------------------

{
  const body = JSON.stringify([{ title: "用什么方案？", options: ["方案甲（推荐）", "方案乙"] }]);
  const text = `前言\n${fence(body)}\n后记`;
  // Visible equivalent replaces the fence; the JSON key "options" is not searchable.
  assert.equal(search.messageSearchUnits({ role: "assistant", key: "m1", blocks: [{ type: "text", text }] })[0].text, "前言\n用什么方案？\n方案甲（推荐）\n方案乙\n后记");
  const occurrences = search.findMessageOccurrences([{ role: "assistant", key: "m1", blocks: [{ type: "text", text }] }], "options");
  assert.equal(occurrences.length, 0);
  assert.equal(search.findMessageOccurrences([{ role: "assistant", key: "m1", blocks: [{ type: "text", text }] }], "方案甲").length, 1);
  // Invalid fence stays in the corpus untouched (it renders as a code block).
  const bad = `前\n${fence("{oops")}\n后`;
  assert.equal(search.messageSearchUnits({ role: "assistant", key: "m2", blocks: [{ type: "text", text: bad }] })[0].text, bad);
}

console.log("choice-block tests passed");
