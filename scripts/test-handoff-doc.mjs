/**
 * 会话交接文档的纯逻辑测试。
 *
 * 2026-10-26 改了生成方式：**唯一路径 = 在源会话里跑一轮**，由会话自己把本会话写成文档。
 * 旧做法（旁路 HTTP 摘要 + 静默退化成「最近原文 + 整项目待办」）实测产出的三份文档全是
 * 退化版，看起来像「越界读取」。这里钉住三件事：
 *   ① 指令自包含（五段结构 / 指定路径 / 禁凭证 / 别把正文贴进对话）；
 *   ② 文档校验能挡住「看着成功其实是空壳」；
 *   ③ 主进程里**不再有**旁路 HTTP 摘要那条老路（防止有人「顺手加回来」）。
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
  HANDOFF_DOC_SECTIONS_EN,
  HANDOFF_DOC_SECTIONS_ZH,
  HANDOFF_DOC_MIN_CHARS,
  HANDOFF_TURN_TIMEOUT_MS,
  buildHandoffDocInstruction,
  handoffDocPath,
  inspectHandoffDoc,
  isHandoffDocPath,
} = await import("../src/main/handoff-doc.ts");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

// ---- [1] 指令：五段结构 + 指定路径 -----------------------------------------
{
  for (const [lang, sections] of [
    ["zh", HANDOFF_DOC_SECTIONS_ZH],
    ["en", HANDOFF_DOC_SECTIONS_EN],
  ]) {
    const path = lang === "zh" ? "E:/proj/.mpi/handoff/a.md" : "/p/.mpi/handoff/a.md";
    const instruction = buildHandoffDocInstruction(path, lang);
    for (const section of sections) {
      assert.ok(instruction.includes(`## ${section}`), `${lang} 指令缺少小节：${section}`);
    }
    assert.ok(instruction.includes(path), `${lang} 指令必须带上确切落盘路径`);
    assert.ok(/\bwrite\b|write 工具/.test(instruction), `${lang} 指令必须要求用 write 工具落盘`);
    ok(`${lang} 指令：五段结构 + 路径 + 用 write 落盘`);
  }
}

// ---- [2] 指令：安全与体积约束 ----------------------------------------------
{
  for (const lang of ["zh", "en"]) {
    const instruction = buildHandoffDocInstruction("/p/.mpi/handoff/a.md", lang);
    assert.ok(/密钥|tokens?/i.test(instruction), "必须明确禁止带凭证");
    assert.ok(/800/.test(instruction), "必须有字数上限");
    // 正文必须留在文件里，否则会话内那一轮会把整篇文档贴进对话（用户要的是可读的过程，不是一屏文档）
    assert.ok(lang === "zh" ? instruction.includes("不要把文档正文贴进对话") : /Do NOT paste/i.test(instruction));
    assert.ok(instruction.length < 2000, "指令要短——它会被写进会话上下文");
    ok(`${lang} 指令：禁凭证 + 800 字上限 + 正文不贴对话`);
  }
}

// ---- [3] 文档校验：合格 ----------------------------------------------------
{
  const doc = [
    "# 交接文档",
    "",
    "## 目标",
    "把 choices 面板写坏时的重试补完。".repeat(3),
    "## 已完成",
    "重试扩展与测试已落地。".repeat(3),
    "## 关键决定",
    "修正指令用 display:false。".repeat(3),
    "## 未完成 / 下一步",
    "真机复测锁屏播报。".repeat(3),
    "## 注意事项",
    "不要动 gate 白名单。".repeat(3),
  ].join("\n");
  const info = inspectHandoffDoc(doc, "zh");
  assert.equal(info.ok, true, `合格文档不该被判失败：${JSON.stringify(info)}`);
  assert.deepEqual(info.missing, []);
  ok("五段齐全且够长 → 判为合格");
}

// ---- [4] 文档校验：空壳 / 缺段 / 太短 --------------------------------------
{
  // 「已写入：…」这种一句回复绝不能被当成文档（旧实现最怕的情况）
  assert.equal(inspectHandoffDoc("已写入：E:/p/.mpi/handoff/a.md", "zh").ok, false);
  // 只有一两段、其余全缺
  const partial = `# 交接\n\n## 目标\n${"内容".repeat(100)}`;
  assert.equal(inspectHandoffDoc(partial, "zh").ok, false);
  // 段都在但太短
  const tooShort = HANDOFF_DOC_SECTIONS_ZH.map((s) => `## ${s}\n一句话`).join("\n");
  assert.ok(tooShort.length < HANDOFF_DOC_MIN_CHARS + 40, "构造的样本应接近下限");
  assert.equal(inspectHandoffDoc(tooShort, "zh").ok, false, "长度不到下限应判失败");
  ok("空壳 / 缺段 / 过短 → 判为不合格");
}

// ---- [5] 文档校验：小节标题必须独占一行 ------------------------------------
{
  const doc = `# 交接\n\n见下文的 ## 目标是假的标题\n${"填充".repeat(200)}`;
  assert.equal(inspectHandoffDoc(doc, "zh").ok, false, "正文里提到的 ## 目标 不能算小节");
  ok("正文里顺带提到的「## 目标」不算小节标题");
}

// ---- [6] 落盘路径 ----------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-handoff-"));
  try {
    const path = handoffDocPath(dir, new Date(2026, 9, 26, 7, 54, 21));
    assert.ok(existsSync(join(dir, ".mpi", "handoff")), "应自动创建 .mpi/handoff 目录");
    assert.ok(path.replace(/\\/g, "/").endsWith(".mpi/handoff/20261026-075421.md"), `路径不符：${path}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  ok("落到 <cwd>/.mpi/handoff/YYYYMMDD-HHmmss.md（目录自动创建）");
}

// ---- [7] 路径守卫 ----------------------------------------------------------
{
  assert.equal(isHandoffDocPath("E:\\proj", "E:\\proj\\.mpi\\handoff\\a.md"), true);
  assert.equal(isHandoffDocPath("/p", "/p/.mpi/handoff/a.md"), true);
  assert.equal(isHandoffDocPath("/p", "/q/.mpi/handoff/a.md"), false, "项目外不算");
  assert.equal(isHandoffDocPath("/p", "/p/docs/handoff/a.md"), false, "不是 .mpi/handoff 也不算");
  ok("路径守卫只认 <cwd>/.mpi/handoff/");
}

// ---- [8] 超时必须早于客户端超时 --------------------------------------------
{
  // PWA 与安卓对 thread.handoff 的请求超时都是 180s；主机更早收手才能把它变成一条正常错误。
  assert.ok(HANDOFF_TURN_TIMEOUT_MS < 180_000, `主机超时 ${HANDOFF_TURN_TIMEOUT_MS}ms 必须小于客户端的 180s`);
  ok(`主机超时 ${Math.round(HANDOFF_TURN_TIMEOUT_MS / 1000)}s < 客户端 180s`);
}

// ---- [9] 反漂移：主进程里不许再有旁路 HTTP 摘要 ----------------------------
{
  const ipc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
  for (const banned of ["buildHandoffPrompt", "buildFallbackDoc", "pickHandoffMessages", "buildTranscript"]) {
    assert.ok(!ipc.includes(banned), `ipc.ts 不该再用 ${banned}（旁路摘要那条老路已废弃）`);
  }
  assert.ok(ipc.includes("generateHandoffDocInSession"), "ipc.ts 必须走会话内一轮生成文档");
  assert.ok(
    /ensureHandoffBridge|ensureRemoteBridge\(ref\)\s*;[\s\S]{0,400}generateHandoffDocInSession/.test(ipc),
    "生成文档前应先把源会话的桥弄起来（会话可能已被空闲回收）",
  );
  const mod = readFileSync(new URL("../src/main/handoff-doc.ts", import.meta.url), "utf8");
  for (const banned of ["buildHandoffPrompt", "buildFallbackDoc", "pickHandoffMessages"]) {
    assert.ok(!mod.includes(banned), `handoff-doc.ts 不该再导出 ${banned}`);
  }
  ok("反漂移：主进程只剩会话内一路，无旁路 HTTP 摘要");
}

console.log(`\n交接文档测试通过：${n} 项`);
