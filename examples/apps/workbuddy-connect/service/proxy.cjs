"use strict";
/**
 * 鉴权透传代理：MPI（pi）→ 本机 HTTP → WorkBuddy 网关。
 *
 * v2 的核心变化：**不再经过 WorkBuddy CLI**。实测网关本身就是 OpenAI 兼容的
 * `POST /v2/chat/completions`（Bearer + X-User-Id + X-Domain，且**必须** stream），
 * 所以代理只做三件事：
 *   1. 把 /v1/chat/completions 原样转发到 /v2/chat/completions；
 *   2. 注入最新 token 与两个身份头（token 过期/App 刷新后自动跟随）；
 *   3. 流式原样回传；客户端要非流式时，在内部用 stream 取上游、自行聚合成
 *      chat.completion（content / tool_calls / finish_reason / usage 都取自上游末帧）。
 *
 * tools、tool_choice、并行调用、assistant.tool_calls、role:"tool" + tool_call_id
 * 全部**不改写**——工具由 pi 执行，代理不执行任何东西。
 *
 * 没有 CLI 时代的单飞串行锁：请求并发执行，只保留一个可配置的上限。
 */

const http = require("node:http");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { homedir } = require("node:os");
const { extname, join, resolve: resolvePath } = require("node:path");

const UPSTREAM_PATH = "/v2/chat/completions";
const REQUEST_TIMEOUT_MS = 300000;

function upstreamBase(domain) {
  const d = String(domain || "").trim().toLowerCase();
  if (d === "workbuddy.ai" || d.endsWith(".workbuddy.ai")) return "https://www.workbuddy.ai";
  if (d === "codebuddy.ai" || d.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
  return "https://www.workbuddy.cn";
}

function upstreamHeaders(cred) {
  return {
    Authorization: `Bearer ${cred.token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
    ...(cred.uid ? { "X-User-Id": cred.uid } : {}),
    ...(cred.domain ? { "X-Domain": cred.domain } : {}),
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function errorBody(message, type) {
  return { error: { message, type } };
}

/** 图片引用缓存目录（MPI 的 image-ref 扩展写入，同机可由本代理直接读盘）。 */
const IMAGE_REF_DIRS = [join(homedir(), ".cache", "mpi-image-ref"), join(homedir(), ".cache", "il")];
const REF_URL_RE = /^data:image\/x-(?:strata|il)-(path|ref);base64,/;
const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** 只允许读这两个缓存目录里的文件：引用本来就是它们生成的，别把代理变成任意读盘通道。 */
function insideRefCache(file) {
  const norm = (p) => {
    const abs = resolvePath(p);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  };
  const target = norm(file);
  return IMAGE_REF_DIRS.some((dir) => target.startsWith(norm(dir) + require("node:path").sep));
}

/** 路径引用 / hash 引用 → 真实 data URL；不是引用或还原失败返回 null。 */
function resolveImageRef(url) {
  const m = REF_URL_RE.exec(url);
  if (!m) return null;
  const payload = url.slice(m[0].length).trim();
  try {
    let file = null;
    if (m[1] === "path") {
      if (!insideRefCache(payload) || !existsSync(payload)) return null;
      file = payload;
    } else {
      // hash 引用：缓存文件名就是 <hash>.<ext>
      for (const dir of IMAGE_REF_DIRS) {
        if (!existsSync(dir)) continue;
        const hit = readdirSync(dir).find((name) => name.startsWith(payload + "."));
        if (hit) {
          file = join(dir, hit);
          break;
        }
      }
      if (!file) return null;
    }
    const mime = MIME_BY_EXT[extname(file).toLowerCase()] || "image/png";
    return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * 把 MPI image-ref 扩展造成的引用还原成真实图片。
 *
 * 那个扩展会在 **回环地址** 的 provider 上把 `{type:"image"}` 换成
 * `data:image/x-strata-path;base64,<本机路径>`（它以为对面是 Strata 视觉服务）。
 * 本代理写的是 `http://127.0.0.1:<port>/v1`，正好落在这个判定里，
 * 上游 WorkBuddy 拿到的就成了一条“不是图片的图片” → 400 / code 11135。
 */
function resolveImageRefs(body) {
  if (!Array.isArray(body.messages)) return 0;
  let fixed = 0;
  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) continue;
    message.content = message.content.map((part) => {
      const url = part?.image_url?.url;
      if (typeof url !== "string" || !REF_URL_RE.test(url)) return part;
      const real = resolveImageRef(url);
      if (!real) return part;
      fixed++;
      return { ...part, image_url: { ...part.image_url, url: real } };
    });
  }
  return fixed;
}

/** 上游错误码：图片识别失败。见 isTransientImageReject 的说明。 */
const IMAGE_UNRECOGNIZED_CODE = 11135;

/**
 * 上游图片识别偶发失败：`{"code":11135}` +「replace the image」。
 * 实测同一张合法 PNG 用同一会话重放就能过，所以这不是请求格式问题
 * （格式错是 11101 Parse message failed），而是它图片服务那侧的一次失败。
 */
function isTransientImageReject(status, text) {
  if (status !== 400) return false;
  return new RegExp(`"code"\\s*:\\s*${IMAGE_UNRECOGNIZED_CODE}\\b`).test(text) || /replace the image/i.test(text);
}

/**
 * 图片识别失败时存一份**失败请求**的取证快照（图片只留 sha256 / 长度 / 头尾片段）。
 * 这个错误与请求体具体内容相关，线上复现时没有请求体只能靠猜。
 */
function dumpRejectedRequest(debugDir, info, log) {
  if (!debugDir) return;
  try {
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { createHash } = require("node:crypto");
    mkdirSync(debugDir, { recursive: true });
    const summarize = (b64) => ({
      bytes: Math.floor((b64.length * 3) / 4),
      sha256: createHash("sha256").update(b64).digest("hex").slice(0, 32),
      head: b64.slice(0, 48),
      note: "base64 已脱敏",
    });
    const redact = (node) => {
      if (Array.isArray(node)) return node.map(redact);
      if (!node || typeof node !== "object") return node;
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === "data" && typeof v === "string" && v.length > 256) out.data = summarize(v);
        else if (k === "url" && typeof v === "string" && v.startsWith("data:") && v.length > 256) {
          const comma = v.indexOf(",");
          out.url = { prefix: v.slice(0, comma + 1), ...summarize(v.slice(comma + 1)) };
        } else out[k] = redact(v);
      }
      return out;
    };
    const file = join(debugDir, "last-image-reject.json");
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...info, body: redact(info.body) }, null, 2), "utf8");
    log(`[local] 已存失败请求快照：${file}`);
  } catch (e) {
    log(`[local] 写请求快照失败：${e?.message || e}`);
  }
}

/** 把上游 HTTP 错误映射成 OpenAI 风格（客户端能按 status 分类处理）。 */
function mapUpstreamError(status, text, log) {
  let detail = "";
  try {
    const j = JSON.parse(text);
    detail = String(j.msg || j.message || j.error_msg || j.error?.message || "").slice(0, 300);
  } catch {
    detail = String(text || "").slice(0, 300);
  }
  if (status === 401 || status === 403) {
    log(`[upstream] ${status} 鉴权失败：${detail}`);
    return { status: 401, body: errorBody(`WorkBuddy 登录已失效或未授权（${detail || status}）。请在 WorkBuddy 桌面端重新登录后重试。`, "invalid_api_key") };
  }
  if (isTransientImageReject(status, text)) {
    log(`[upstream] ${IMAGE_UNRECOGNIZED_CODE} 图片识别失败（已重试）：${detail}`);
    return {
      status: 400,
      body: errorBody(
        "WorkBuddy 上游这次没认出这张图片（code 11135，已自动重试 1 次）。通常重发一次就好；持续失败请换一张图（JPG/PNG，别用极小或损坏的图），或换个模型。",
        "image_unrecognized",
      ),
    };
  }
  if (status === 429) {
    log(`[upstream] 429 限流：${detail}`);
    return { status: 429, body: errorBody(`WorkBuddy 上游限流：${detail || "稍后重试"}`, "rate_limit_error") };
  }
  if (status >= 500) {
    log(`[upstream] ${status} 服务端错误：${detail}`);
    return { status: 502, body: errorBody(`WorkBuddy 上游错误（${status}）：${detail || "无详情"}`, "upstream_error") };
  }
  log(`[upstream] ${status} 请求错误：${detail}`);
  return { status, body: errorBody(`WorkBuddy 上游拒绝请求（${status}）：${detail || "无详情"}`, "invalid_request_error") };
}

/** 把一份 SSE 流聚合成标准 chat.completion 对象（用于客户端要非流式时）。 */
async function aggregateStream(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  let id = "";
  let model = "";
  let created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage = null;
  const toolCalls = new Map();

  const consume = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (typeof chunk.created === "number") created = chunk.created;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = Number(call.index) || 0;
        const slot = toolCalls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
        if (call.id) slot.id = call.id;
        if (call.type) slot.type = call.type;
        if (call.function?.name) slot.function.name += call.function.name;
        if (call.function?.arguments) slot.function.arguments += call.function.arguments;
        toolCalls.set(index, slot);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      consume(line);
    }
  }
  if (buffer.trim()) consume(buffer.trim());

  const message = { role: "assistant", content: content };
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  }
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id: id || "chatcmpl-wb-" + Date.now().toString(36),
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: usage
      ? {
          prompt_tokens: Number(usage.prompt_tokens) || 0,
          completion_tokens: Number(usage.completion_tokens) || 0,
          total_tokens: Number(usage.total_tokens) || 0,
        }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string[]} opts.models
 * @param {() => {token:string, uid:string, domain:string}} opts.credential  每次请求现读
 * @param {number} [opts.maxConcurrency]
 * @param {string} [opts.debugDir]  图片识别失败时落取证快照的目录
 * @param {(line: string) => void} [opts.log]
 */
function startProxy({ port, models, credential, maxConcurrency = 4, debugDir = "", log = () => {} }) {
  let active = 0;
  const waiters = [];
  const acquire = async () => {
    if (active < maxConcurrency) {
      active++;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    active++;
  };
  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };

  /** 调一次上游；401 时强制重读一次凭证再试。 */
  const callUpstream = async (upstreamBody) => {
    let cred = credential();
    let response = await fetch(upstreamBase(cred.domain) + UPSTREAM_PATH, {
      method: "POST",
      headers: upstreamHeaders(cred),
      body: upstreamBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      log("[local] 上游 401，重读 WorkBuddy 登录态后重试一次");
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      cred = credential({ force: true });
      response = await fetch(upstreamBase(cred.domain) + UPSTREAM_PATH, {
        method: "POST",
        headers: upstreamHeaders(cred),
        body: upstreamBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }
    return response;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        return sendJson(res, 200, { ok: true, service: "workbuddy-proxy", active });
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(res, 200, {
          object: "list",
          data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "workbuddy" })),
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return sendJson(res, 400, errorBody("请求体不是合法 JSON", "invalid_request_error"));
        }
        // pi 在 model.reasoning && compat.supportsDeveloperRole 时会用 role:"developer"
        // 发系统指令；WorkBuddy 上游只认 "system"，会把 developer 当成
        // 「Illegal API invocation from an unapproved channel」。这里统一规范，
        // 任何 OpenAI 风格客户端都不会再踩。
        if (Array.isArray(body.messages)) {
          let rewritten = 0;
          body.messages = body.messages.map((m) => {
            if (m && m.role === "developer") {
              rewritten++;
              return { ...m, role: "system" };
            }
            return m;
          });
          if (rewritten > 0) log(`[local] messages 里有 ${rewritten} 条 role=developer，已改写为 system`);
        }
        const restored = resolveImageRefs(body);
        if (restored > 0) log(`[local] 还复了 ${restored} 张图片引用（image/x-strata-* → 真实图片）`);
        const clientWantsStream = body.stream === true;
        // 上游只接受流式；对外两种都支持。
        const upstreamBody = JSON.stringify({ ...body, stream: true });

        await acquire();
        const started = Date.now();
        try {
          let response;
          try {
            response = await callUpstream(upstreamBody);
          } catch (e) {
            const isTimeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
            log(`[local] 上游请求失败（${isTimeout ? "超时" : "网络"}）：${e?.message || e}`);
            return sendJson(
              res,
              isTimeout ? 504 : 502,
              errorBody(
                isTimeout ? `WorkBuddy 上游超时（>${Math.round(REQUEST_TIMEOUT_MS / 1000)}s）` : `连不上 WorkBuddy 上游：${e?.message || e}`,
                isTimeout ? "upstream_timeout" : "upstream_unreachable",
              ),
            );
          }

          if (!response.ok) {
            let text = await response.text();
            // 图片识别偶发失败（11135）先原地重试一次，仍失败才报给客户端。
            if (isTransientImageReject(response.status, text)) {
              log(`[local] 上游图片识别失败（code ${IMAGE_UNRECOGNIZED_CODE}），重试一次`);
              try {
                response = await callUpstream(upstreamBody);
                text = response.ok ? "" : await response.text();
              } catch (e) {
                log(`[local] 图片重试请求失败：${e?.message || e}`);
                return sendJson(res, 502, errorBody(`连不上 WorkBuddy 上游：${e?.message || e}`, "upstream_unreachable"));
              }
            }
            if (!response.ok) {
              if (isTransientImageReject(response.status, text)) {
                dumpRejectedRequest(
                  debugDir,
                  { status: response.status, upstreamText: String(text).slice(0, 600), responseOk: false, body },
                  log,
                );
              }
              const mapped = mapUpstreamError(response.status, text, log);
              return sendJson(res, mapped.status, mapped.body);
            }
          }

          if (clientWantsStream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
              Connection: "keep-alive",
            });
            try {
              for await (const chunk of response.body) {
                res.write(chunk);
              }
              res.end();
            } catch (e) {
              // 断流：已经发了响应头，只能在流里补一条错误事件，然后结束。
              log(`[upstream] 流中断：${e?.message || e}`);
              res.write(`data: ${JSON.stringify(errorBody(`上游断流：${e?.message || e}`, "upstream_error"))}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            }
            log(`[local] 流式完成 ${Date.now() - started}ms`);
            return;
          }

          const aggregated = await aggregateStream(response.body);
          log(`[local] 非流式聚合完成 ${Date.now() - started}ms finish=${aggregated.choices[0].finish_reason}`);
          return sendJson(res, 200, aggregated);
        } finally {
          release();
        }
      }

      return sendJson(res, 404, errorBody(`未知路径 ${url.pathname}`, "not_found"));
    } catch (e) {
      log(`[local] 处理失败：${e?.message || e}`);
      if (!res.headersSent) sendJson(res, 500, errorBody(String(e), "internal_error"));
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { startProxy, upstreamBase, aggregateStream };
