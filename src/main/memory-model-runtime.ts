/**
 * 记忆模型 —— 运行期包装层（读 config.json + models.json）。
 *
 * 为什么拆两层：纯解析（memory-model.ts）不依赖 electron，可以在普通 node 里单测；
 * 这一层才碰配置与磁盘，只做「取数据 → 交给纯函数解析」。
 */
import { getConfig } from "./config";
import { defaultMemoryModel, resolveMemoryModelFrom, type MemoryModelRef, type ProvidersLike } from "./memory-model";
import { readModelsFile, readThinking } from "./models-service";

/** 会话主模型规格：扩展侧据此用当前会话的主模型。 */
export const SESSION_MODEL_SPEC = "__session__";

/**
 * 解析当前生效的记忆模型。
 * 未设置 → **不调模型**（只用基础记忆读写改，等价 mem0 的 infer:false）。
 */
export function resolveMemoryModel(): MemoryModelRef {
  const cfg = getConfig().memoryModel;
  const mode = cfg?.mode ?? (cfg?.provider && cfg?.model ? "model" : "none");
  if (mode === "none") return defaultMemoryModel();
  if (mode === "session") {
    // 主进程侧没有「当前会话」这个概念，用配置里的默认模型代表"主模型"；
    // 没配默认模型就只能不调模型（宁可关掉也不要瞎挑一个）。
    const th = readThinking();
    const provider = typeof th?.defaultProvider === "string" ? th.defaultProvider : "";
    const model = typeof th?.defaultModel === "string" ? th.defaultModel : "";
    if (!provider || !model) {
      return {
        ...defaultMemoryModel(),
        describe: "跟随主模型：主进程侧读不到默认模型（设置里没选「默认模型」）→ dream 改为不调模型",
      };
    }
    try {
      const providers = readModelsFile().providers as ProvidersLike;
      const r = resolveMemoryModelFrom(provider, model, providers, "model");
      return { ...r, mode: "session", source: "session", describe: `跟随主模型（默认模型 ${provider}/${model}）` };
    } catch {
      return { ...defaultMemoryModel(), describe: "跟随主模型：读 models.json 失败 → dream 改为不调模型" };
    }
  }
  let providers: ProvidersLike = {};
  try {
    providers = readModelsFile().providers as ProvidersLike;
  } catch {
    return { ...defaultMemoryModel(), describe: "读 models.json 失败 → 不使用模型" };
  }
  return resolveMemoryModelFrom(cfg?.provider, cfg?.model, providers, "model");
}

/**
 * 给 pi 子进程的环境变量（捕获扩展据此调模型）。
 * 只传"规格"，端点/鉴权由扩展在 pi 运行时里解析（completeSimple 处理协议细节）。
 */
export function memoryModelEnv(): Record<string, string> {
  const cfg = getConfig().memoryModel;
  const mode = cfg?.mode ?? (cfg?.provider && cfg?.model ? "model" : "none");
  const env: Record<string, string> = {};
  if (mode === "session") {
    env.MPI_MEMORY_MODEL = SESSION_MODEL_SPEC;
    env.MPI_MEMORY_MODEL_DESC = "跟随主模型";
  } else if (mode === "model" && cfg?.provider && cfg?.model) {
    env.MPI_MEMORY_MODEL = `${cfg.provider}/${cfg.model}`;
    env.MPI_MEMORY_MODEL_DESC = `${cfg.provider}/${cfg.model}`;
  } else {
    env.MPI_MEMORY_MODEL = ""; // 显式传空：扩展据此完全不调模型
    env.MPI_MEMORY_MODEL_DESC = "未设置（只用基础记忆读写）";
  }
  return env;
}
