"use strict";
/**
 * workbuddy-connect 应用服务入口（MPI 应用商店，v2）。
 *
 * v2 与 v1 的区别：**不再经过 WorkBuddy CLI**。实测 WorkBuddy 网关本身就是
 * OpenAI 兼容的 `/v2/chat/completions`，所以这里只做「鉴权透传代理」：
 *
 *   1. 读本机 WorkBuddy 登录态（解密 accessToken）；
 *   2. 从 `/v3/config` 读模型目录（真实 maxInputTokens/maxOutputTokens/工具能力）；
 *   3. 起一个本机代理（/v1/chat/completions → /v2/chat/completions，注入最新 token）；
 *   4. 把模型写进 `~/.pi/agent/models.json`；
 *   5. 每天自动签到领积分。
 *
 * 工具由 pi 执行，代理只转发、不改写——权限门保持在 MPI 侧。
 */

const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const { readCredential } = require("./wb-auth.cjs");
const { startProxy, upstreamBase } = require("./proxy.cjs");
const { runDaily } = require("./wb-checkin.cjs");

const PROVIDER_ID = "workbuddy";
const BASE_PORT = 8096;
const MAX_PORT_TRIES = 30;
const CONFIG_TIMEOUT_MS = 20000;

let active = null;

function agentModelsPath() {
  const dir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(dir, "models.json");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const dir = join(file, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = file + ".mpi-workbuddy.tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/** 读账号目录（/v3/config）：每个模型带真实上下文/输出上限与工具能力。 */
async function fetchCatalog(cred) {
  const base = upstreamBase(cred.domain);
  const res = await fetch(base + "/v3/config", {
    headers: {
      Authorization: `Bearer ${cred.token}`,
      Accept: "application/json",
      "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
      ...(cred.uid ? { "X-User-Id": cred.uid } : {}),
      ...(cred.domain ? { "X-Domain": cred.domain } : {}),
    },
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`/v3/config HTTP ${res.status}`);
  const json = await res.json();
  const list = json && json.data && Array.isArray(json.data.models) ? json.data.models : [];
  return list
    .filter((m) => m && typeof m.id === "string" && m.id)
    .map((m) => ({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      contextWindow: Number(m.maxInputTokens) || 200000,
      maxTokens: Number(m.maxOutputTokens) || 8192,
      supportsTools: m.supportsToolCall !== false,
      // 平台声明 supportsImages 不等于真能看图：目录里另有 disabledMultimodal 时以它为准。
      supportsImages: m.supportsImages === true && m.disabledMultimodal !== true,
      reasoning: Boolean(m.relatedModels && m.relatedModels.reasoning),
      credits: typeof m.credits === "string" ? m.credits : "",
    }));
}

function writeProvider({ models, port, dataDir, imageOverride = [] }) {
  const file = agentModelsPath();
  const doc = readJson(file) || { providers: {} };
  if (!doc.providers || typeof doc.providers !== "object") doc.providers = {};
  const existing = doc.providers[PROVIDER_ID];
  if (existing) {
    const baseUrl = typeof existing.baseUrl === "string" ? existing.baseUrl : "";
    if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseUrl)) {
      return { created: false, skipped: true };
    }
  }
  const backup = join(dataDir, "models.json.before-workbuddy.json");
  try {
    if (!existsSync(backup) && existsSync(file)) writeFileSync(backup, readFileSync(file));
  } catch {
    /* 备份失败不阻断 */
  }
  doc.providers[PROVIDER_ID] = {
    name: "WorkBuddy",
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "workbuddy-proxy",
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning,
      // WorkBuddy 上游不接受 role:"developer"；关掉 pi 的 developer 角色推断（双保险）。
      compat: { supportsDeveloperRole: false },
      ...((imageOverride.length ? imageOverride.includes(m.id) : m.supportsImages) ? { input: ["text", "image"] } : {}),
    })),
  };
  writeJsonAtomic(file, doc);
  return { created: !existing, skipped: false, file };
}

function removeProvider() {
  const file = agentModelsPath();
  const doc = readJson(file);
  if (!doc || !doc.providers || !doc.providers[PROVIDER_ID]) return false;
  const baseUrl = typeof doc.providers[PROVIDER_ID].baseUrl === "string" ? doc.providers[PROVIDER_ID].baseUrl : "";
  if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseUrl)) return false;
  delete doc.providers[PROVIDER_ID];
  writeJsonAtomic(file, doc);
  return true;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = require("node:net").createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort() {
  for (let p = BASE_PORT; p < BASE_PORT + MAX_PORT_TRIES; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`找不到空闲端口（${BASE_PORT}–${BASE_PORT + MAX_PORT_TRIES - 1}）`);
}

function splitModels(raw) {
  return String(raw || "")
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function activate(host) {
  // 重复激活（含覆盖安装后重新启用）时先关掉上一次的 server：否则旧监听还占着
  // 端口，新实例顺延到 8097，旧服务继续答——看起来像「代码没更新」。
  if (active && active.server) {
    await new Promise((resolve) => active.server.close(() => resolve()));
    active = null;
  }
  const fields = host.getFieldValues();
  const wanted = splitModels(fields.models);
  // 目录里的 supportsImages 可能不准（平台声明 ≠ 模型能力），允许用配置覆盖。
  const imageOverride = splitModels(fields.imageModels);
  const autoCheckin = (fields.autoCheckin || "on") !== "off";
  const maxConcurrency = Math.max(1, Math.min(8, Number(fields.maxConcurrency) || 4));

  host.status("starting", "读取 WorkBuddy 登录态…");
  let cached = { at: 0, cred: readCredential() };
  const credential = (opts = {}) => {
    if (!opts.force && Date.now() - cached.at < 60000) return cached.cred;
    cached = { at: Date.now(), cred: readCredential() };
    return cached.cred;
  };
  host.log(`已读取 WorkBuddy 登录态（${cached.cred.domain || "未知区域"}，uid ${cached.cred.uid ? "已获取" : "缺失"}）`);

  host.status("starting", "读取模型目录…");
  let catalog = [];
  try {
    catalog = await fetchCatalog(cached.cred);
  } catch (e) {
    host.log(`读取 /v3/config 失败（将用空目录继续）：${e instanceof Error ? e.message : String(e)}`);
  }
  let models = catalog;
  if (wanted.length > 0) {
    const byId = new Map(catalog.map((m) => [m.id, m]));
    const missing = wanted.filter((id) => !byId.has(id));
    if (missing.length) host.log(`配置里的模型不在当前账号目录中：${missing.join(", ")}`);
    models = wanted.map((id) => byId.get(id) || { id, name: id, contextWindow: 200000, maxTokens: 8192, supportsTools: true });
  }
  if (models.length === 0) {
    host.log("模型目录为空：/v1/models 将为空，请在「接入的模型」里显式填 id");
  }
  for (const m of models.slice(0, 12)) {
    host.log(`模型 ${m.id} · ctx ${m.contextWindow} / out ${m.maxTokens}${m.credits ? ` · ${m.credits}` : ""}${m.supportsTools ? "" : " · 无工具"}${m.supportsImages ? " · 图片" : ""}${m.reasoning ? " · 思考" : ""}`);
  }

  const port = await pickPort();
  const { server, port: boundPort } = await startProxy({
    port,
    models: models.map((m) => m.id),
    credential,
    maxConcurrency,
    debugDir: host.app.dataDir,
    log: (line) => host.log(line),
  });

  const writeResult = writeProvider({ models, port: boundPort, dataDir: host.app.dataDir, imageOverride });
  if (writeResult.skipped) {
    host.log(`models.json 里已有自定义的 ${PROVIDER_ID} provider（baseUrl 不是本应用写的），未覆盖`);
  } else {
    host.log(`已写入 provider ${PROVIDER_ID} → http://127.0.0.1:${boundPort}/v1（${models.length} 个模型，真实上下文/输出上限）`);
  }

  let checkin = { status: "disabled" };
  if (autoCheckin) {
    checkin = await runDaily({
      token: credential().token,
      uid: credential().uid,
      domain: credential().domain,
      dataDir: host.app.dataDir,
      log: (line) => host.log(line),
    });
  } else {
    host.log("自动签到已关闭");
  }

  active = { server, port: boundPort };
  const checkinText =
    checkin.status === "claimed"
      ? `签到 +${checkin.credit} 积分`
      : checkin.status === "already"
        ? "今天已签到"
        : checkin.status === "failed"
          ? "签到失败（见日志）"
          : checkin.status === "skipped"
            ? "签到已处理"
            : "未签到";
  host.status("ready", `代理 :${boundPort} · ${models.length} 模型 · ${checkinText}`);
  host.log("提示：不再需要 WorkBuddy CLI；models.json 已更新，新建会话（或重启 MPI）后生效。");
  return {};
}

async function deactivate(host) {
  const current = active;
  active = null;
  if (current && current.server) {
    await new Promise((resolve) => current.server.close(() => resolve()));
  }
  const removed = removeProvider();
  host.log(removed ? `已移除 provider ${PROVIDER_ID}` : "没有需要移除的 provider");
}

module.exports = { activate, deactivate };
