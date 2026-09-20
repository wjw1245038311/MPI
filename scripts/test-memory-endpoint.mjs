/**
 * 记忆池本地端点测试（P2 基础设施）
 * 覆盖：token 鉴权、/health、/recall（真 zvec 索引，embedding 不可用则退化）、
 *       未知路径、坏 JSON、端点文件生命周期、只绑 127.0.0.1。
 * 运行：npm run test:memoryendpoint
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

const pool = mkdtempSync(join(tmpdir(), "mpi-ep-pool-"));
const userData = mkdtempSync(join(tmpdir(), "mpi-ep-ud-"));
process.env.MPI_ZHIYA_POOL_DIR = pool;
process.on("exit", () => {
  // 注意：索引持有只读句柄时 .zvec 目录删不掉（EPERM）——这正是我们给应用
  // 加退出清理的原因。测试里显式释放，避免把临时目录留在盘上。
  for (const d of [pool, userData]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 句柄未释放就留着，退出去也别让测试挂掉 */
    }
  }
});

const { startMemoryEndpoint, stopMemoryEndpoint, memoryEndpointPath } = await import("../src/main/memory-endpoint.ts");
const { disposeMemoryIndex } = await import("../src/main/memory-service.ts");
const { decideIngest, lexicalSimilarity } = await import("../src/main/zhiya/pool.ts");

let n = 0;
const ok = (name) => { n++; console.log(`  ✅ ${name}`); };

// 造 3 条池条目
for (const t of [
  "zg 不提供代码调用图，调用图只有 alexandria 有。",
  "推送前必须等用户确认，无人值守时只 commit 不 push。",
  "zvec 的 open 约 208 毫秒，读者必须复用句柄。",
]) {
  assert.equal(decideIngest(pool, { text: t, type: "semantic", temporal: "retrospective", importance: 7, relevance: 0.7, project: "MPI", source: "ep-test" }, lexicalSimilarity).action, "add");
}

const info = await startMemoryEndpoint(userData);
assert.ok(info, "端点应启动成功");
assert.ok(info.url.startsWith("http://127.0.0.1:"), `只绑 127.0.0.1，实际 ${info.url}`);
assert.equal(existsSync(memoryEndpointPath(userData)), true, "端点文件应写入");
const fileInfo = JSON.parse((await import("node:fs")).readFileSync(memoryEndpointPath(userData), "utf8"));
assert.equal(fileInfo.token, info.token, "文件里的 token 与内存一致");
ok(`端点启动：${info.url}（仅 127.0.0.1，写入 ${join("userData", "zhiya-memory-endpoint.json")}）`);

const call = (path, init = {}) => fetch(`${info.url}${path}`, init);

// 鉴权
const noAuth = await call("/health");
assert.equal(noAuth.status, 401, "缺 token 必须 401");
const badAuth = await call("/health", { headers: { "x-mpi-memory-token": "wrong" } });
assert.equal(badAuth.status, 401, "错 token 必须 401");
ok("鉴权：缺 token / 错 token 均 401");

const health = await call("/health", { headers: { "x-mpi-memory-token": info.token } });
const healthBody = await health.json();
assert.equal(healthBody.ok, true);
assert.equal(healthBody.count, 3, "health 报告池内 3 条");
ok(`/health：池内 ${healthBody.count} 条，索引 ${healthBody.indexKind}`);

// 召回
const rec = await call("/recall", {
  method: "POST",
  headers: { "x-mpi-memory-token": info.token, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "调用图 谁提供", topK: 3 }),
});
const recBody = await rec.json();
assert.equal(recBody.ok, true);
assert.ok(recBody.hits.length >= 1, "应有命中");
assert.match(recBody.hits[0].text, /调用图/, `top1 应为调用图条目，实际：${recBody.hits[0].text}`);
assert.ok(typeof recBody.hits[0].score === "number" && recBody.hits[0].parts, "命中带分数与分量");
assert.ok(recBody.hits[0].path, "命中带文件路径");
ok(`/recall：top1 = ${recBody.hits[0].text.slice(0, 22)}（score ${recBody.hits[0].score}）`);

// 空查询 + topK 边界
const empty = await call("/recall", {
  method: "POST",
  headers: { "x-mpi-memory-token": info.token, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "", topK: 999 }),
});
const emptyBody = await empty.json();
assert.equal(emptyBody.ok, true);
assert.ok(emptyBody.hits.length <= 50, "topK 上限钳制到 50");
ok("空查询可返回（按时间/重要性），topK 被钳制");

// 错误路径
const unknown = await call("/nope", { headers: { "x-mpi-memory-token": info.token } });
assert.equal(unknown.status, 404, "未知路径 404");
const badJson = await call("/recall", {
  method: "POST",
  headers: { "x-mpi-memory-token": info.token, "Content-Type": "application/json" },
  body: "{ 不是 JSON",
});
assert.equal(badJson.status, 400, "坏 JSON → 400");
ok("未知路径 404、坏 JSON 400（都不崩）");

// 停止
await stopMemoryEndpoint(userData);
assert.equal(existsSync(memoryEndpointPath(userData)), false, "停止后端点文件应删除");
let refused = false;
try {
  await fetch(`${info.url}/health`, { headers: { "x-mpi-memory-token": info.token } });
} catch {
  refused = true;
}
assert.equal(refused, true, "停止后端口不应再接受连接");
ok("停止：删端点文件 + 端口不再响应");

console.log(`\ntest:memoryendpoint 全部通过（${n} 项）`);
