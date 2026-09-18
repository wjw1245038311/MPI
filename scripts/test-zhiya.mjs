import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
// Must be registered BEFORE importing zhiya.ts (which imports "./config").
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { composeZhiyaPrompt, HARD_RULES_HEADING, ZHIYA_PROMPT_BUDGET } = await import("../src/main/zhiya.ts");

const P = (s) => `## 知芽 · ${s}`;

// --- order: 硬规则 → 指针 → 画像 → 工作空间 --------------------------------
const full = composeZhiyaPrompt({
  agreement: `# 协作约定\n\n${HARD_RULES_HEADING}\n- 推送前等确认。\n\n## 环境\n- 只用 bash。\n`,
  persona: `# 人物画像\n\n## 个人定位\n后端工程师。\n`,
  workspace: `# 工作空间\n\n## 空间布局\n- Work/ — 调试区。\n`,
});
const iRules = full.indexOf("推送前等确认");
const iPtr = full.indexOf("知芽 · 指针");
const iPersona = full.indexOf("后端工程师");
const iWorkspace = full.indexOf("Work/ — 调试区");
assert.ok(iRules > -1 && iPtr > -1 && iPersona > -1 && iWorkspace > -1, "all four blocks present");
assert.ok(iRules < iPtr && iPtr < iPersona && iPersona < iWorkspace, `order 硬规则→指针→画像→工作空间 (${iRules},${iPtr},${iPersona},${iWorkspace})`);

// --- 约定：只有硬规则节进提示词，长文留在文件里按需读 ------------------------
assert.ok(!full.includes("只用 bash"), "agreement body outside 硬规则 is NOT injected");
assert.ok(full.includes("agreement.md"), "pointer names the agreement file");

// --- 硬规则节在遇到同级/更高级标题时停止 -------------------------------------
const sibling = composeZhiyaPrompt({
  agreement: `${HARD_RULES_HEADING}\n- 规则 A\n## 环境\n- 不该出现\n# 一级标题\n- 也不该出现\n`,
});
assert.ok(sibling.includes("规则 A"), "hard rule kept");
assert.ok(!sibling.includes("不该出现"), "next sibling heading stops the section");
assert.ok(!sibling.includes("也不该出现"), "higher-level heading stops the section");
// 子标题（更深）仍属于本节
assert.ok(
  composeZhiyaPrompt({ agreement: `${HARD_RULES_HEADING}\n- 规则 A\n### 子条\n- 子条内容\n## 环境\n- 停\n` }).includes("子条内容"),
  "deeper sub-heading stays inside the section",
);

// --- 缺硬规则节 → 不成空块；注释与空节被剥离 ---------------------------------
const noRules = composeZhiyaPrompt({ agreement: `# 协作约定\n\n## 环境\n<!-- 待填 -->\n`, persona: "", workspace: "" });
assert.ok(!noRules.includes("硬规则"), "no empty 硬规则 block when the section is missing");
assert.ok(!noRules.includes("<!--"), "html comments stripped");
// 注释被剥后「## 环境」成了空节 → 整节丢弃，标题也不该冒出来
assert.ok(!noRules.includes("## 环境"), "empty sections are dropped entirely");

// --- 指针永远在场：三份文件全空也要有 ---------------------------------------
const empty = composeZhiyaPrompt({});
assert.ok(empty.includes("知芽 · 指针"), "pointer block is unconditional");
assert.ok(empty.includes(".alexandria/knowledge/"), "pointer names the project KB");

// --- 画像/工作空间的标题形状 -------------------------------------------------
assert.ok(full.includes(P("人物画像")), "persona heading");
assert.ok(full.includes(P("工作空间")), "workspace heading");

// --- 超预算：从尾部截断，硬规则与指针必须存活 -------------------------------
const big = composeZhiyaPrompt({
  agreement: `${HARD_RULES_HEADING}\n- 头部硬规则必须存活\n`,
  persona: "# 画像\n" + "甲".repeat(2000),
  workspace: "# 工作空间\n" + "乙".repeat(4000),
});
assert.ok(big.length <= ZHIYA_PROMPT_BUDGET, `truncated to budget (${big.length} <= ${ZHIYA_PROMPT_BUDGET})`);
assert.ok(big.includes("头部硬规则必须存活"), "hard rules survive truncation");
assert.ok(big.includes("知芽 · 指针"), "pointer survives truncation");
assert.ok(big.includes("已截断"), "truncation marker present");

// --- 前置前言（H1 标题 + 作者提示）不注入 -------------------------------
const withPreamble = composeZhiyaPrompt({
  persona: `# 人物画像（Persona）\n\n> 只写关于我的事实，规则写约定。\n<!-- 作者注释 -->\n\n## 个人定位\n后端工程师。\n`,
  workspace: `# 工作空间\n\n> 房子与水电煤。\n\n## 空间布局\n- Work/ — 调试区。\n`,
});
assert.ok(withPreamble.includes("后端工程师"), "section body kept");
assert.ok(!withPreamble.includes("只写关于我的事实"), "persona preamble (blockquote) NOT injected");
assert.ok(!withPreamble.includes("房子与水电煤"), "workspace preamble NOT injected");
assert.ok(!withPreamble.includes("# 人物画像（Persona）"), "H1 title NOT injected");
// 无 ## 的纯文本文件按原样注入（不能被截成空）
assert.ok(composeZhiyaPrompt({ persona: "自由文本画像" }).includes("自由文本画像"), "plain-text file without headings survives");

console.log("zhiya prompt tests passed");
