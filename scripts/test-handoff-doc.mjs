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
  HANDOFF_PROMPT_PATH_TOKEN,
  buildHandoffDocInstruction,
  builtinHandoffTemplate,
  fillHandoffTemplate,
  handoffDocTitle,
  handoffFallbackTitle,
  handoffDocPath,
  inspectHandoffDoc,
  isHandoffDocPath,
} = await import("../src/main/handoff-doc.ts");

const NL = String.fromCharCode(10);

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

// ---- [1] 指令：极简 + 指定路径（不再提任何小节） -----------------------
{
  for (const lang of ["zh", "en"]) {
    const path = lang === "zh" ? "E:/proj/.mpi/handoff/a.md" : "/p/.mpi/handoff/a.md";
    const instruction = buildHandoffDocInstruction(path, lang);
    assert.ok(instruction.includes(path), `${lang} 指令必须带上确切落盘路径`);
    assert.ok(/\bwrite\b|write 工具/.test(instruction), `${lang} 指令必须要求用 write 工具落盘`);
    assert.equal(instruction.split("\n").length, 3, `${lang} 指令应为 3 行（实际 ${instruction.split("\n").length} 行）`);
    ok(`${lang} 指令：3 行（${instruction.length} 字符）+ 路径 + 用 write 落盘`);
  }
}

// ---- [2] 指令：安全与体积约束 ----------------------------------------------
{
  for (const lang of ["zh", "en"]) {
    const instruction = buildHandoffDocInstruction("/p/.mpi/handoff/a.md", lang);
    assert.ok(/密钥|tokens?/i.test(instruction), "必须明确禁止带凭证");
    // 2026-10-26 用户：字数上限 / 不回贴正文都是风格要求，已从默认指令里删掉
    assert.ok(instruction.length < 400, "指令要极短——它会被写进会话上下文");
    assert.ok(!/800/.test(instruction), "默认指令不该再带字数上限");
    ok(`${lang} 指令（${instruction.length} 字符）：禁凭证 + 极短`);
  }
}

// ---- [2.5] 自定义指令模板（Settings → 对话配置 → 交接文档指令）------------
{
  const path = "E:/proj/.mpi/handoff/a.md";
  // 内置默认模板：用占位符写成，里面不该出现具体路径
  for (const lang of ["zh", "en"]) {
    const tpl = builtinHandoffTemplate(lang);
    assert.ok(tpl.includes(HANDOFF_PROMPT_PATH_TOKEN), `${lang} 内置模板必须用 {{path}} 占位`);
    const filled = buildHandoffDocInstruction(path, lang);
    assert.ok(!filled.includes(HANDOFF_PROMPT_PATH_TOKEN), `${lang} 输出里不能残留占位符`);
    assert.ok(filled.includes(path), `${lang} 输出必须带真实路径`);
  }
  // 自定义模板：{{path}} 替换
  const custom = `只写事实。\n写到这里：${HANDOFF_PROMPT_PATH_TOKEN}`;
  const out = buildHandoffDocInstruction(path, "zh", custom);
  assert.ok(out.startsWith("只写事实。"), "自定义模板应原样生效");
  assert.ok(out.includes(path) && !out.includes(HANDOFF_PROMPT_PATH_TOKEN), "自定义模板里的占位符应被替换");
  // 自定义模板忘了写占位符：自动补上落盘路径与回执要求（否则交接必失败）
  const noToken = buildHandoffDocInstruction(path, "zh", "随便写两句");
  assert.ok(noToken.includes("随便写两句"), "模板正文应保留");
  assert.ok(noToken.includes(path), "没写占位符时必须自动补路径");
  assert.ok(/write/.test(noToken) && noToken.includes("已写入"), "没写占位符时要补 write + 回执要求");
  // 空白自定义 = 内置默认
  assert.equal(
    buildHandoffDocInstruction(path, "zh", "   "),
    buildHandoffDocInstruction(path, "zh"),
    "空白模板应回落内置默认",
  );
  ok("自定义交接指令：占位符替换 / 缺占位符自动补路径 / 空白回落内置默认");
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

// ---- [4] 文档校验：空壳 / 太短（结构不再强制） ----------------------------
{
  // 「已写入：…」这种一句回复绝不能被当成文档（旧实现最怕的情况）
  assert.equal(inspectHandoffDoc("已写入：E:/p/.mpi/handoff/a.md", "zh").ok, false);
  // 只有两行、信息极少的短篇也不算（低于字数下限）
  const stub = `# 修个样式\n改了一行 CSS。`;
  assert.equal(inspectHandoffDoc(stub, "zh").ok, false, "太短的空壳应判失败");
  // 缺段但内容够：2026-10-26 起不再因为「没凑满五段」而判失败
  const partial = `# 改了一处样式\n只改了抽屉宽度，其余未动。${"补一句。".repeat(20)}`;
  assert.equal(inspectHandoffDoc(partial, "zh").ok, true, "内容够就不该因缺段被判失败");
  // 五段各一句、长度已过下限：只看长度，结构不再是门槛
  const tooShort = HANDOFF_DOC_SECTIONS_ZH.map((s) => `## ${s}\n一句话`).join("\n");
  assert.ok(tooShort.length >= HANDOFF_DOC_MIN_CHARS, "五段各一句应已超过下限");
  ok("回执 / 过短 → 不合格；缺段但够长 → 合格");
}

// ---- [5] 文档校验：回执行不计入字数 ------------------------------------
{
  const doc = `# 交接\n## 目标\n只干了很少的事。\n已写入：E:/p/.mpi/handoff/a.md`;
  const info = inspectHandoffDoc(doc, "zh");
  assert.ok(info.chars < doc.trim().length, "回执行不应计入字数");
  ok("「已写入：<路径>」行不计入正文长度");
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

// ---- [8] 会话名 = 文档的一级标题 -------------------------------------------
{
  // 用户 2026-10-26：交接文档标题通常写得很好，直接拿来当新会话会话名，链式交接也自带连续性。
  assert.equal(handoffDocTitle("# 修手机端交接的配置继承" + NL + NL + "## 目标" + NL + "…", "交接 2026-10-26 07:54"), "修手机端交接的配置继承");
  // 泛标题没有信息量 → 回落到兜底值
  assert.equal(handoffDocTitle("# 交接文档" + NL + "## 目标", "交接 2026-10-26 07:54"), "交接 2026-10-26 07:54");
  assert.equal(handoffDocTitle("# 交接文档（项目 MPI）", "交接 2026-10-26 07:54"), "交接 2026-10-26 07:54");
  assert.equal(handoffDocTitle("# Handoff" + NL + "## Goal", "Handoff 2026-10-26 07:54"), "Handoff 2026-10-26 07:54");
  // 没有 H1（例如只有二级标题）→ 兜底
  assert.equal(handoffDocTitle("## 目标" + NL + "正文", "交接 1"), "交接 1");
  // markdown 强调符号与结尾标点要去掉
  assert.equal(handoffDocTitle("# **发版 v0.12.2**。", "x"), "发版 v0.12.2");
  // 过长要截断（侧栏放不下）
  const long = handoffDocTitle(`# ${"长".repeat(120)}`, "x");
  assert.ok(long.length <= 60 && long.endsWith("…"), `应截断到 60 字以内：${long.length}`);
  // 兜底名取文件名时间戳
  assert.equal(handoffFallbackTitle("E:/p/.mpi/handoff/20261026-075421.md"), "交接 2026-10-26 07:54");
  ok("会话名取文档一级标题（泛标题/缺 H1 回落时间戳，过长截断）");
}

// ---- [9] 指令要求写一级标题 ------------------------------------------------
{
  for (const lang of ["zh", "en"]) {
    const instruction = buildHandoffDocInstruction("/p/.mpi/handoff/a.md", lang);
    assert.ok(
      lang === "zh" ? instruction.includes("一级标题") : /`#` heading/i.test(instruction),
      "指令必须要求写一级标题——它就是新会话的会话名",
    );
    assert.ok(lang === "zh" ? instruction.includes("会话名") : /session's title/i.test(instruction), "指令要说明标题的去向");
  }
  ok("指令要求用一级标题概括（并说明它就是会话名）");
}

// ---- [10] 超时必须早于客户端超时 -------------------------------------------
{
  // PWA 与安卓对 thread.handoff 的请求超时都是 180s；主机更早收手才能把它变成一条正常错误。
  assert.ok(HANDOFF_TURN_TIMEOUT_MS < 180_000, `主机超时 ${HANDOFF_TURN_TIMEOUT_MS}ms 必须小于客户端的 180s`);
  ok(`主机超时 ${Math.round(HANDOFF_TURN_TIMEOUT_MS / 1000)}s < 客户端 180s`);
}

// ---- [11] 反漂移：主进程里不许再有旁路 HTTP 摘要 ---------------------------
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
