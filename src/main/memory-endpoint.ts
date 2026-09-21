/**
 * 记忆池本地查询端点（供 pi 扩展等外部进程做语义召回）。
 *
 * 为什么需要它：pi 扩展是以 `?raw` 源码写进 userData 的、**自包含**，
 * import 不到本仓的索引模块；所以让主进程（唯一持有 zvec 索引的那一方）
 * 暴露一个本地端点，扩展用 HTTP 来查。
 *
 * 安全边界（这是 MPI 里的第一个本地 HTTP 服务，刻意收紧）：
 *   - 只绑 127.0.0.1（端口交给系统随机分配），**不绑 0.0.0.0**，不进 tailnet；
 *   - 每次启动生成随机 token，请求必须带 `x-mpi-memory-token`；
 *   - 端点信息（url + token）落在 <userData>/zhiya-memory-endpoint.json，
 *     扩展通过 env 拿到这个文件路径后**每次现读**（端点重启换端口也能跟上）；
 *   - 进程退出时删除该文件。
 * 受信边界 = 同一用户的本机会话（token 文件在用户目录下），与 SSH agent 一类的
 * 常见做法同级别；不试图防御同用户下的恶意进程。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMemoryIndex, memoryIndexKind, memoryPoolDir } from "./memory-service";
import { listEntries } from "./zhiya/pool";

export const MEMORY_ENDPOINT_FILENAME = "zhiya-memory-endpoint.json";

export interface MemoryEndpointInfo {
  url: string;
  token: string;
  pid: number;
  startedAt: string;
}

let server: Server | null = null;
let info: MemoryEndpointInfo | null = null;

export function memoryEndpointPath(userDataDir: string): string {
  return join(userDataDir, MEMORY_ENDPOINT_FILENAME);
}

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/** 命中 → 完整卡片（带上正文，扩展就不必再去读文件）。 */
async function recall(payload: { text?: string; topK?: number; filter?: unknown }) {
  const poolDir = memoryPoolDir();
  const entries = listEntries(poolDir).entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const index = await getMemoryIndex();
  const topK = Math.max(1, Math.min(50, Number(payload.topK) || 5));
  const hits = await index.recall({ text: String(payload.text || ""), topK, filter: payload.filter as never });
  return {
    indexKind: memoryIndexKind(),
    poolDir,
    total: entries.length,
    hits: hits
      .map((h) => {
        const e = byId.get(h.id);
        if (!e) return null;
        return {
          id: h.id,
          score: Number(h.score.toFixed(4)),
          parts: {
            recency: Number(h.parts.recency.toFixed(3)),
            relevance: Number(h.parts.relevance.toFixed(3)),
            importance: Number(h.parts.importance.toFixed(3)),
          },
          text: e.text,
          importance: e.importance,
          type: e.type,
          temporal: e.temporal,
          project: e.project,
          recurrence: e.recurrence,
          createdAt: e.createdAt,
          path: e.path,
        };
      })
      .filter(Boolean),
  };
}

/** 启动（幂等）。返回端点信息；失败时不抛，由调用方决定是否降级。 */
export async function startMemoryEndpoint(userDataDir: string): Promise<MemoryEndpointInfo | null> {
  if (info) return info;
  try {
    const token = randomBytes(24).toString("hex");
    server = createServer((req, res) => {
      void (async () => {
        try {
          if (req.headers["x-mpi-memory-token"] !== token) {
            return send(res, 401, { ok: false, error: "token 无效" });
          }
          const url = new URL(req.url || "/", "http://127.0.0.1");
          if (req.method === "GET" && url.pathname === "/health") {
            const poolDir = memoryPoolDir();
            const entries = listEntries(poolDir).entries;
            return send(res, 200, {
              ok: true,
              indexKind: memoryIndexKind() ?? "未初始化",
              poolDir,
              count: entries.length,
              pid: process.pid,
            });
          }
          if (req.method === "POST" && url.pathname === "/recall") {
            const body = (await readBody(req)) as Record<string, unknown>;
            return send(res, 200, { ok: true, ...(await recall(body as never)) });
          }
          return send(res, 404, { ok: false, error: "未知路径" });
        } catch (e) {
          return send(res, 400, { ok: false, error: (e as Error).message });
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    info = { url: `http://127.0.0.1:${port}`, token, pid: process.pid, startedAt: new Date().toISOString() };
    writeFileSync(memoryEndpointPath(userDataDir), JSON.stringify(info, null, 1), "utf8");
    // eslint-disable-next-line no-console
    console.log(`[memory] 本地查询端点已启动：${info.url}（仅 127.0.0.1，需 token）`);
    return info;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[memory] 本地端点启动失败（扩展会降级为字面检索）：", (e as Error).message);
    server = null;
    info = null;
    return null;
  }
}

/** 退出时调用：关服务 + 删端点文件。 */
export async function stopMemoryEndpoint(userDataDir: string): Promise<void> {
  const s = server;
  server = null;
  info = null;
  try {
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  } catch {
    /* 退出路径，尽力而为 */
  }
  try {
    const p = memoryEndpointPath(userDataDir);
    if (existsSync(p)) rmSync(p, { force: true });
  } catch {
    /* 同上 */
  }
}
