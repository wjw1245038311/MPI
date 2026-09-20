/**
 * 扩展 ↔ 主进程端点 的召回链路集成测试。
 *
 * 做法同 test:memorycmd：扩展自包含、import 不到，所以**从源码抽出召回逻辑**再跑，
 * 避免两处漂移。端点是真跑的（main 侧 memory-endpoint），池子是临时目录。
 * 运行：npm run test:memoryrecall
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { transform } from "esbuild";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

const pool = mkdtempSync(join(tmpdir(), "mpi-recall-pool-"));
const userData = mkdtempSync(join(tmpdir(), "mpi-recall-ud-"));
process.env.MPI_ZHIYA_POOL_DIR = pool;
process.on("exit", () => {
  for (const d of [pool, userData]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 句柄未释放就留着 */ }
  }
});

// 端点文件路径在扩展里是**进程启动时**读一次（env 固定，只有文件内容会变），
// 所以测试要在求值那段代码之前就把 env 指向真实路径。
process.env.MPI_MEMORY_ENDPOINT_FILE = join(userData, "zhiya-memory-endpoint.json");

// --- 从扩展源码抽出召回段 ---
const src = readFileSync("src/main/mpi-memory-ext.ts", "utf8");
const start = src.indexOf("// 语义召回：走主进程的本地端点");
const end = src.indexOf("function agoLabel");
assert.ok(start > 0 && end > start, "能定位到扩展里的召回实现");
const block = src.slice(start, end).replace(/^export /gm, "");
const js = (await transform(block, { loader: "ts", target: "es2022" })).code;
const factory = new Function("readFileSync", "fetch", `${js}\nreturn { remoteRecall, formatHits, endpointInfo };`);
const { remoteRecall, formatHits, endpointInfo } = factory(readFileSync, fetch);

let n = 0;
const ok = (name) => { n++; console.log(`  ✅ ${name}`); };

// --- 端点没起时：安静降级，不抛 ---
assert.equal(endpointInfo(), null, "端点文件不存在时返回 null");
assert.equal(await remoteRecall("任意"), null, "拿不到端点时 remoteRecall 返回 null（交给字面检索降级）");
ok("端点缺席：安静降级，不抛异常");

// --- 起真端点 ---
const { startMemoryEndpoint, stopMemoryEndpoint, memoryEndpointPath } = await import("../src/main/memory-endpoint.ts");
const { disposeMemoryIndex } = await import("../src/main/memory-service.ts");
const { decideIngest, lexicalSimilarity } = await import("../src/main/zhiya/pool.ts");

for (const t of [
  "zg 不提供代码调用图，调用图只有 alexandria 有。",
  "推送前必须等用户确认，无人值守时只 commit 不 push。",
  "zvec 的 open 约 208 毫秒，读者必须复用句柄。",
]) {
  decideIngest(pool, { text: t, type: "semantic", temporal: "retrospective", importance: 7, relevance: 0.7, project: "MPI", source: "recall-test" }, lexicalSimilarity);
}
const info = await startMemoryEndpoint(userData);
assert.ok(info, "端点启动");
assert.equal(memoryEndpointPath(userData), process.env.MPI_MEMORY_ENDPOINT_FILE, "端点文件路径与扩展读到的一致");

const ep = endpointInfo();
assert.ok(ep && ep.url === info.url && ep.token === info.token, "扩展能从端点文件读到 url + token");
ok(`扩展读到端点：${ep.url}`);

const remote = await remoteRecall("谁能给我代码调用图", 3);
assert.ok(remote, "应拿到召回结果");
assert.ok(remote.hits.length >= 1, "至少一条命中");
assert.match(remote.hits[0].text, /调用图/, `top1 应为调用图条目，实际 ${remote.hits[0].text}`);
ok(`语义召回（${remote.kind}）：top1 = ${remote.hits[0].text.slice(0, 22)}`);

// 关键词不重叠的语义命中
const sem = await remoteRecall("中文记忆搜索为什么不好使", 3);
assert.ok(sem && sem.hits.length >= 1, "换了说法也应命中");
ok(`换说法也能命中：${sem.hits[0].text.slice(0, 26)}`);

// --- 渲染成给模型看的文本 ---
const text = formatHits("语义检索 zvec", remote.hits);
assert.match(text, /命中的记忆/);
assert.match(text, /1\. \[/, "带序号与分数");
assert.match(text, /重要性 \d/);
assert.equal(formatHits("x", []), "记忆池里没有相关的记忆。");
ok("formatHits：格式正确、空结果有明确说法");

// --- 端点不可达（服务停了）时仍能降级 ---
await stopMemoryEndpoint(userData);
assert.equal(await remoteRecall("调用图"), null, "端点停掉后 remoteRecall 返回 null 而非抛错");
ok("端点中途停掉：仍安静降级");

await disposeMemoryIndex();
console.log(`\ntest:memoryrecall 全部通过（${n} 项）`);
