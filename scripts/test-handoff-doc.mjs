/**
 * 会话交接文档的纯逻辑测试。
 *
 * 覆盖：消息挑选、转录预算、提示词结构（含「不要带密钥」）、退化文档、
 * 模型输出归一化、落盘路径。
 *
 * 运行：npm run test:handoffdoc
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const {
  pickHandoffMessages,
  buildTranscript,
  buildHandoffPrompt,
  buildFallbackDoc,
  normalizeDoc,
  writeHandoffDoc,
  buildHandoffKickoff,
  HANDOFF_MAX_MESSAGES,
  HANDOFF_DOC_CHARS,
} = await import("../src/main/handoff-doc.ts");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

// ---- [1] 消息挑选 ----------------------------------------------------------
{
  const messages = [
    { role: "system", content: "系统提示不进交接" },
    { role: "user", content: "目标：把 choices 改完" },
    { role: "assistant", content: [{ type: "thinking", thinking: "思考不进" }, { type: "text", text: "好的，先看代码" }] },
    { role: "toolResult", content: "工具结果不进" },
    { role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "text", text: "读完了" }] },
  ];
  const picked = pickHandoffMessages(messages);
  assert.deepEqual(picked, [
    { role: "user", text: "目标：把 choices 改完" },
    { role: "assistant", text: "好的，先看代码" },
    { role: "assistant", text: "读完了" },
  ]);
  ok("只收 user/assistant 的 text 块（跳过 system/tool/thinking）");
}

// ---- [2] 条数上限 ----------------------------------------------------------
{
  const many = Array.from({ length: HANDOFF_MAX_MESSAGES + 10 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const picked = pickHandoffMessages(many);
  assert.equal(picked.length, HANDOFF_MAX_MESSAGES);
  assert.equal(picked[picked.length - 1].text, `m${HANDOFF_MAX_MESSAGES + 9}`, "保留最新的一段");
  ok("超长会话只取最近 N 条（尾部）");
}

// ---- [3] 转录预算与顺序 ----------------------------------------------------
{
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `x`.repeat(1000) + i }));
  const transcript = buildTranscript(messages, 5000);
  assert.ok(transcript.length <= 5000 + 200, "转录应受预算约束");
  assert.ok(transcript.includes("x".repeat(10)), "内容非空");
  const firstLine = transcript.split("\n\n")[0];
  assert.ok(/用户：|助手：/.test(firstLine));
  ok("按预算从最新往回取，再按时间正序拼接");
}

// ---- [4] 提示词结构 + 安全约束 --------------------------------------------
{
  for (const lang of ["zh", "en"]) {
    const prompt = buildHandoffPrompt("MPI", "用户：hi", lang);
    for (const must of ["## ", lang === "zh" ? "交接文档" : "Handoff"]) {
      assert.ok(prompt.includes(must), `提示词缺少 ${must}`);
    }
    assert.ok(/密钥|secrets|token/i.test(prompt), "必须明确禁止带凭证");
    assert.ok(prompt.includes("用户：hi"), "转录要进提示词");
  }
  // 待办：来自待办面板的未完成项要进提示词（用户 2026-10-25 要求「带待办」）。
  const withTodos = buildHandoffPrompt("MPI", "用户：hi", "zh", ["- 修 choices 面板", "- 发 v0.12.0"]);
  assert.ok(withTodos.includes("未完成待办"), "提示词要带待办节");
  assert.ok(withTodos.includes("- 修 choices 面板"), "待办条目要原样进入");
  ok("提示词含固定结构 + 禁止密钥 + 待办（中英）");
}

// ---- [5] 退化文档 ----------------------------------------------------------
{
  const doc = buildFallbackDoc("MPI", [{ role: "user", text: "最后一句" }], "zh");
  assert.ok(doc.startsWith("# 交接文档"));
  assert.ok(doc.includes("模型不可用"));
  assert.ok(doc.includes("最后一句"));
  const withTodos = buildFallbackDoc("MPI", [{ role: "user", text: "最后一句" }], "zh", ["- 待办A"]);
  assert.ok(withTodos.includes("未完成待办") && withTodos.includes("- 待办A"), "退化文档也要带待办");
  ok("模型不可用时退化为「最近原文」文档（含待办）");
}

// ---- [6] 输出归一化 --------------------------------------------------------
{
  assert.equal(normalizeDoc("```markdown\n# 标题\n正文\n```"), "# 标题\n正文");
  assert.equal(normalizeDoc("# 直接标题"), "# 直接标题");
  const long = normalizeDoc("y".repeat(HANDOFF_DOC_CHARS + 500));
  assert.equal(long.length, HANDOFF_DOC_CHARS, "文档长度要有上限");
  ok("去掉代码围栏并截断到上限");
}

// ---- [7] 落盘路径 ----------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-handoff-"));
  try {
    const path = writeHandoffDoc(dir, "# 交接\n内容", new Date(2026, 9, 25, 13, 5, 7));
    assert.ok(existsSync(path));
    assert.ok(path.split(String.fromCharCode(92)).join("/").endsWith(".mpi/handoff/20261025-130507.md"), `路径不符：${path}`);
    assert.equal(readFileSync(path, "utf8"), "# 交接\n内容\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  ok("落到 <cwd>/.mpi/handoff/YYYYMMDD-HHmmss.md（带结尾换行）");
}

// ---- [8] 新会话开场白 ------------------------------------------------------
{
  for (const lang of ["zh", "en"]) {
    const kickoff = buildHandoffKickoff("/p/.mpi/handoff/a.md", lang);
    assert.ok(kickoff.includes("/p/.mpi/handoff/a.md"), "必须给出文档绝对路径");
    assert.ok(kickoff.length < 500, "开场白要短（细节留文件里）");
  }
  ok("开场白只指向文档、足够短");
}

console.log(`\n交接文档测试通过：${n} 项`);
