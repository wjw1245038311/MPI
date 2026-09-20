/**
 * P5-3 面板规模实测：126 条池子在面板各操作上的耗时
 *
 * 方案里标注的未测项：**大列表下面板是否还流畅**。这里只量数据层
 * （`memory-panel.ts` 的快照/过滤/展开）与文件扫描，不含渲染（渲染得在应用里看）。
 *
 *   npm run bench:panel-scale             # 用真实池子
 *   POOL=<dir> npm run bench:panel-scale  # 指定池子
 */
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { buildSnapshot } = await import("../src/main/memory-panel.ts");
const { listEntries } = await import("../src/main/zhiya/pool.ts");
const { ZvecIndex } = await import("../src/main/zhiya/zvec-index.ts");
const { defaultPoolDir } = await import("../src/main/zhiya/memory-index.ts");

const poolDir = process.env.POOL || defaultPoolDir();
const ms = (fn) => {
  const t = process.hrtime.bigint();
  const r = fn();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, r };
};

const { r: count, ms: tScan } = ms(() => listEntries(poolDir).entries.length);
console.log(`\n池：${poolDir}（${count} 条）`);
console.log(`[1/5] 全池扫描+解析（listEntries）：${tScan.toFixed(1)}ms`);

// 快照：面板每次打开/刷新都走这条
const rounds = 5;
const snapTimes = [];
let last;
for (let i = 0; i < rounds; i++) {
  const { ms: t, r } = ms(() => buildSnapshot({ poolDir }));
  snapTimes.push(t);
  last = r;
}
snapTimes.sort((a, b) => a - b);
console.log(`[2/5] 面板快照 buildSnapshot：p50 ${snapTimes[2].toFixed(1)}ms（5 轮：${snapTimes.map((x) => x.toFixed(0)).join("/")}）`);
console.log(`      条目视图 ${last.entries.length} 条（limit ${200}）/ 提案 ${last.proposals.length} 份 / 已截断 ${last.matched > last.entries.length ? "是" : "否"}`);

// 过滤：面板里每敲一个字符就重算一次
const filters = [
  { q: "记忆池" },
  { q: "zvec" },
  { project: "MPI" },
  { project: "Work", type: "semantic" },
  { status: "inbox", range: "30d" },
  { q: "迁移", range: "7d", sort: "oldest" },
];
console.log(`[3/5] 过滤（每敲一键就跑一次，必须快）：`);
for (const q of filters) {
  let t = 0;
  for (let i = 0; i < 3; i++) t += ms(() => buildSnapshot({ poolDir, query: q })).ms;
  const avg = t / 3;
  console.log(`      ${JSON.stringify(q).padEnd(48)} ${avg.toFixed(1)}ms`);
}

// 索引：面板/Recall 的数据来源
const { ms: tIndex, r: idx } = ms(() => null);
void tIndex;
console.log(`[4/5] zvec 打开（含 FTS，复用句柄才是常态）：`);
const tOpen = process.hrtime.bigint();
const z = await ZvecIndex.open(poolDir, { readOnly: true });
console.log(`      打开耗时 ${(Number(process.hrtime.bigint() - tOpen) / 1e6).toFixed(0)}ms`);
const qs = ["记忆池 索引", "zvec 分诊", "迁移 幂等", "面板 批量", "并发 写者"];
const lat = [];
for (let r = 0; r < 4; r++) {
  for (const q of qs) {
    const t = process.hrtime.bigint();
    await z.recall({ text: q, topK: 10 });
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
}
lat.sort((a, b) => a - b);
console.log(`[5/5] 检索（${lat.length} 次）：p50 ${lat[Math.floor(lat.length / 2)].toFixed(1)}ms · p90 ${lat[Math.floor(lat.length * 0.9)].toFixed(1)}ms · max ${lat[lat.length - 1].toFixed(1)}ms`);
await z.close();
void idx;
console.log(`\n口径：面板数据层在 ${count} 条规模下的快照 ≈ ${snapTimes[2].toFixed(0)}ms、过滤 ≈ ${(snapTimes[2] / 3).toFixed(0)}ms 级；渲染开销需在应用里实测。`);
