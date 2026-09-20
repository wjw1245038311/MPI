/**
 * 「记忆模型」解析（设置 → 模型与提供商 → 记忆模型）
 *
 * 记忆系统有两处要调模型：
 *   ① 扩展侧（捕获抽取 + 重要性打分）—— 通过环境变量拿到端点
 *   ② 主进程侧（dream 写 lesson 正文）—— 直接调
 * 所以这个模块把「选哪个模型」收敛成一处解析，两边共用，避免两套逻辑漂移。
 *
 * 未设置时走**本机 LM Studio**（:1234 + qwen3.8-27b）——这正是 mem0 当初的配置，
 * 也就是"不设置也和 mem0 一样"。
 *
 * 只支持 OpenAI 兼容协议（chat/completions）：记忆抽取/打分/正文生成都用这一种请求体。
 * 选了 anthropic-messages 这类异构协议的供应商时**明确报错并说明**，不静默乱发请求。
 */
/**
 * 纯解析层：接受入参、不做 IO —— 单测可以在普通 node 里跑（不拉 electron）。
 * 读 config.json / models.json 的包装层在 memory-model-runtime.ts。
 */

/**
 * 记忆模型的三种模式：
 *   none    —— 未设置：**完全不调模型**。基础记忆读写改照常（写入原文/检索/归档），
 *              不做自动抽取、不打分、不生成 lesson 正文（= mem0 用 infer:false 的形态）。
 *   session —— 跟随主模型：用当前会话的主模型（扩展侧拿 ctx.model，主进程侧用配置里的默认模型）。
 *   model   —— 指定供应商+模型。
 */
export type MemoryModelMode = "none" | "session" | "model";

export interface MemoryModelRef {
  mode: MemoryModelMode;
  /** 完整的 chat/completions 端点 */
  url: string;
  /** 模型 id */
  model: string;
  /** Authorization: Bearer <key> 用的密钥（本机 LM Studio 无） */
  key?: string;
  /** 额外请求头（供应商自定义） */
  headers?: Record<string, string>;
  /** 来源：config = 用户在设置里选的；session = 跟随主模型；none = 不调模型；env = 环境变量覆盖 */
  source: "config" | "session" | "none" | "env";
  /** 人类可读的来源说明（日志/设置界面提示用） */
  describe: string;
}

const DEFAULT_URL = "http://127.0.0.1:1234/v1/chat/completions";
const DEFAULT_MODEL = "qwen3.8-27b@q5_k_m";

/** 解析 pi 配置里的 $ENV 引用（与 model-autopilot 的约定一致）。 */
function resolveKeyValue(key?: string): string | undefined {
  if (!key) return undefined;
  const k = key.trim();
  if (k.startsWith("$")) return process.env[k.slice(1)];
  if (k.startsWith("!")) return undefined; // !cmd：这里绝不执行命令
  return k;
}

/** baseUrl → chat/completions 端点（容忍已写全的、或只有 domain 的写法）。 */
export function completionUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/**
 * 未设置时的解析结果：**不调模型**。
 * 环境变量仍可覆盖（CLI/测试口）：显式给了 MPI_MEMORY_LLM_URL 就按 model 模式用。
 */
export function defaultMemoryModel(): MemoryModelRef {
  const url = process.env.MPI_MEMORY_LLM_URL?.trim();
  const model = process.env.MPI_MEMORY_LLM_MODEL?.trim();
  const key = process.env.MPI_MEMORY_LLM_KEY?.trim();
  if (url || model) {
    return {
      mode: "model",
      url: url || "",
      model: model || "",
      key: key || undefined,
      source: "env",
      describe: "环境变量指定（MPI_MEMORY_LLM_*）",
    };
  }
  return {
    mode: "none",
    url: "",
    model: "",
    source: "none",
    describe: "未设置记忆模型：只用基础记忆读写（不做抽取/打分/正文生成）",
  };
}

export interface ProvidersLike {
  [provider: string]: {
    baseUrl?: string;
    api?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    models?: { id: string; baseUrl?: string; api?: string }[];
  };
}

/**
 * 从「选择的供应商+模型」解析出可用的端点。
 * 供应商/模型不存在、协议不兼容、baseUrl 缺失 → **退回本机默认并说明原因**：
 * 宁可退回本机模型，也不要静默拿一个连不上的端点让记忆功能整体哑掉。
 */
export function resolveMemoryModelFrom(
  providerId: string | undefined,
  modelId: string | undefined,
  providers: ProvidersLike,
  mode: "none" | "session" | "model" = "model",
): MemoryModelRef {
  if (mode === "none") return defaultMemoryModel(); // 未设置 = 不调模型
  if (mode === "session") {
    return {
      mode: "session",
      url: "",
      model: "",
      source: "session",
      describe: "跟随主模型（会话的主模型）",
    };
  }
  const pid = providerId?.trim();
  const mid = modelId?.trim();
  if (!pid || !mid) return defaultMemoryModel();

  const p = providers[pid];
  if (!p) {
    return { ...defaultMemoryModel(), describe: `供应商 ${pid} 不在 models.json 里，已改为"不使用模型"` };
  }
  // 模型不在列表里也照样用它：供应商的 models 可能没列全（自托管/动态列表），
  // 而用户明确选了供应商、baseUrl 也在——这时退回本机才是错的。
  const m = (p.models ?? []).find((x) => x.id === mid);
  const api = m?.api ?? p.api ?? "openai-completions";
  if (api === "anthropic-messages") {
    return {
      ...defaultMemoryModel(),
      describe: `供应商 ${pid} 用的是 anthropic-messages 协议，记忆调用只支持 OpenAI 兼容协议，已改为"不使用模型"`,
    };
  }
  const base = (m?.baseUrl ?? p.baseUrl ?? "").trim();
  if (!base) {
    return { ...defaultMemoryModel(), describe: `供应商 ${pid} 没有 baseUrl，已改为"不使用模型"` };
  }
  return {
    mode: "model",
    url: completionUrl(base),
    model: mid,
    key: resolveKeyValue(p.apiKey),
    headers: p.headers,
    source: "config",
    describe: `${pid}/${mid}`,
  };
}

export { DEFAULT_MODEL as MEMORY_DEFAULT_MODEL, DEFAULT_URL as MEMORY_DEFAULT_URL };
