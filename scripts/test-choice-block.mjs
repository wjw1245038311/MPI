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

// Validation limits.
{
  const q = (title, options) => JSON.stringify([{ title, options }]);
  assert.equal(cb.parseChoiceBlockData(q("t", ["a"])), null); // <2 options
  assert.equal(cb.parseChoiceBlockData(q("t", ["a", "b", "c", "d", "e", "f", "g"])), null); // >6 options
  assert.equal(cb.parseChoiceBlockData(q("", ["a", "b"])), null); // empty title
  const many = JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, options: ["a", "b"] })));
  assert.equal(cb.parseChoiceBlockData(many), null); // >6 questions
  assert.ok(cb.parseChoiceBlockData(q("t", ["a", "b"]))); // minimal valid
  // {questions:[...]} wrapper form is accepted too.
  assert.ok(cb.parseChoiceBlockData(JSON.stringify({ questions: [{ title: "t", options: ["a", "b"] }] })));
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
  const parsed = cb.parseChoiceReply(text, questions);
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
  assert.deepEqual(cb.parseChoiceReply(en, questions), { 0: { kind: "option", label: "A" } });
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
