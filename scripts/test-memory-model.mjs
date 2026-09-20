/**
 * 记忆模型解析测试（设置 → 模型与提供商 → 记忆模型）
 *
 * 要钉住的契约：
 *   未设置 → 本机 LM Studio（与 mem0 相同）；选了供应商 → 用它；
 *   供应商/模型不存在、协议不兼容、baseUrl 缺失 → **退回本机并说明原因**（不静默哑掉）。
 *
 * 运行：npm run test:memorymodel
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { completionUrl, defaultMemoryModel, resolveMemoryModelFrom, MEMORY_DEFAULT_MODEL, MEMORY_DEFAULT_URL } =
  await import("../src/main/memory-model.ts");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

// --- baseUrl → 端点 ----------------------------------------------------------
assert.equal(completionUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/chat/completions");
assert.equal(completionUrl("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions", "容忍尾斜杠");
assert.equal(completionUrl("https://x/v1/chat/completions"), "https://x/v1/chat/completions", "已写全的不重复拼");
assert.equal(completionUrl("https://x"), "https://x/chat/completions", "只有域名也能拼");
ok("端点拼接：不同写法都归一成 chat/completions");

// --- 未设置 = 本机默认 -------------------------------------------------------
{
  const keep = { ...process.env };
  delete process.env.MPI_MEMORY_LLM_URL;
  delete process.env.MPI_MEMORY_LLM_MODEL;
  delete process.env.MPI_MEMORY_LLM_KEY;
  const d = defaultMemoryModel();
  assert.equal(d.mode, "none", "未设置 = 不使用模型（不是回退到某个模型）");
  assert.equal(d.source, "none");
  assert.equal(d.url, "", "不调模型时不该有任何端点");
  assert.ok(d.describe.includes("基础记忆读写"), `说明要讲清退化成什么：${d.describe}`);
  ok("未设置：完全不调模型，只用基础记忆读写（= mem0 的 infer:false 形态）");

  // 环境变量可以覆盖（CLI/测试口）
  process.env.MPI_MEMORY_LLM_URL = "http://127.0.0.1:9999/v1/chat/completions";
  process.env.MPI_MEMORY_LLM_KEY = "sk-test";
  const e = defaultMemoryModel();
  assert.equal(e.source, "env");
  assert.equal(e.mode, "model", "显式给了端点就按 model 模式用");
  assert.equal(e.url, "http://127.0.0.1:9999/v1/chat/completions");
  assert.equal(e.key, "sk-test");
  ok("环境变量覆盖生效（CLI/测试用的口子）");
  process.env = keep;
}


// --- 选了供应商 --------------------------------------------------------------
{
  const providers = {
    zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", apiKey: "sk-zh", models: [{ id: "glm-5.3" }] },
    claude: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "sk-x", models: [{ id: "claude-x" }] },
    nobody: { models: [{ id: "m" }] },
  };
  const z = resolveMemoryModelFrom("zhipu", "glm-5.3", providers);
  assert.equal(z.source, "config");
  assert.equal(z.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(z.model, "glm-5.3");
  assert.equal(z.key, "sk-zh", "供应商密钥带出来（云端必需）");
  ok("选了供应商：端点/模型/密钥都对（OpenAI 兼容协议）");

  process.env.MPI_TEST_KEY = "sk-from-env";
  const envRef = resolveMemoryModelFrom("zhipu", "glm-5.3", { zhipu: { ...providers.zhipu, apiKey: "$MPI_TEST_KEY" } });
  assert.equal(envRef.key, "sk-from-env", "$ENV 引用解成环境变量值");
  delete process.env.MPI_TEST_KEY;
  ok("供应商密钥支持 $ENV 引用（与 pi 配置的约定一致）");

  const cases = [
    ["供应商不存在", resolveMemoryModelFrom("nope", "m", providers)],
    ["anthropic 协议不支持", resolveMemoryModelFrom("claude", "claude-x", providers)],
    ["供应商缺 baseUrl", resolveMemoryModelFrom("nobody", "m", providers)],
  ];
  for (const [name, r] of cases) {
    assert.equal(r.mode, "none", `${name} 应退化成「不使用模型」`);
    assert.equal(r.url, "", `${name} 不该留一个连不上的端点`);
    assert.ok(r.describe.includes("不使用模型"), `${name} 必须说明原因：${r.describe}`);
  }
  ok("退化路径：供应商缺失、协议不兼容、无 baseUrl → 退化成「不使用模型」并说明原因");

  assert.equal(resolveMemoryModelFrom(undefined, undefined, providers).mode, "none");
  assert.equal(resolveMemoryModelFrom("zhipu", undefined, providers).mode, "none", "只选了供应商没选模型 → 不使用模型");

  // 显式模式优先
  assert.equal(resolveMemoryModelFrom("zhipu", "glm-5.3", providers, "none").mode, "none", "显式 none 优先");
  const sess = resolveMemoryModelFrom("zhipu", "glm-5.3", providers, "session");
  assert.equal(sess.mode, "session");
  assert.equal(sess.source, "session");
  assert.ok(sess.describe.includes("主模型"));
  ok("模式优先：显式 none / session 覆盖供应商选择（session 交给运行时解析主模型）");

  // 模型不在供应商的 models 列表里：**仍然用它**（供应商可能没列全，比如自托管的动态列表）
  // —— 退回本机反而是错的：用户明确选了供应商，baseUrl 也在。
  const unlisted = resolveMemoryModelFrom("zhipu", "glm-未列出的型号", providers);
  assert.equal(unlisted.source, "config", "未列出的模型仍按所选供应商解析");
  assert.equal(unlisted.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(unlisted.model, "glm-未列出的型号");
  ok("模型未列在供应商 models 里 → 仍用所选供应商（不擅自退回本机）");
  ok("只选一半（缺提供商或缺模型）→ 走默认，不会半吊子生效");
}

console.log(`\ntest:memorymodel 全部通过（${n} 项）`);
