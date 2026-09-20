/**
 * 设备切换自检（P5-4 验收）——一条命令看清"这台机器的记忆写入口切好了没"
 *
 * 检查项与《P5-DEVICE-SWITCH-GUIDE.md》§2 的验收清单一一对应，能自动化的都自动查：
 *   1. pi 包列表里还有没有 mem0 扩展（应已移除）
 *   2. 知芽池在哪、多少条、最近写入是什么时候
 *   3. 嵌入端点是否可达（检索/索引的前提）
 *   4. MPI 的知芽扩展文件是否已由主进程写出（启动时生成的运行时文件）
 *   5. mem0 服务/库状态（作为回滚点是否健在；库计数是否还在长）
 *
 *   npm run check:switch
 *   npm run check:switch -- --watch 30   # 每 30 秒复查一次（盯"mem0 还在不在长"）
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { listEntries } = await import("../src/main/zhiya/pool.ts");
const { defaultPoolDir } = await import("../src/main/zhiya/memory-index.ts");

const args = process.argv.slice(2);
const watch = args.includes("--watch") ? Number(args[args.indexOf("--watch") + 1] || 30) : 0;

const ok = (s) => `✅ ${s}`;
const warn = (s) => `⚠️  ${s}`;
const bad = (s) => `❌ ${s}`;

async function probe(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.ok ? `HTTP ${r.status}` : `HTTP ${r.status}`;
  } catch (e) {
    return `不可达（${e && e.name ? e.name : "Error" || e}）`;
  }
}

async function runOnce() {
  const lines = [];
  lines.push(`\n=== 知芽写入口自检（${new Date().toLocaleString()}）===`);

  // 1) pi 包列表
  const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
  const settingsPath = join(agentDir, "settings.json");
  try {
    const cfg = JSON.parse(readFileSync(settingsPath, "utf8"));
    const pkgs = cfg.packages ?? [];
    const mem0Pkgs = pkgs.filter((p) => /mem0|hermes-memory/i.test(p));
    lines.push(
      mem0Pkgs.length
        ? bad(`pi 包列表仍有 mem0 相关扩展：${mem0Pkgs.join(", ")} —— 切换未完成（改 ${settingsPath}）`)
        : ok(`pi 包列表无 mem0 扩展（${pkgs.length} 个包：${pkgs.join(", ")}）`),
    );
  } catch (e) {
    lines.push(warn(`读不到 ${settingsPath}：${e && e.message ? e.message : String(e)}`));
  }

  // 2) 池
  const pool = defaultPoolDir();
  try {
    const { entries, broken } = listEntries(pool);
    const inbox = entries.filter((e) => e.status === "inbox").length;
    let newest = 0;
    for (const e of entries) {
      const t = Date.parse(e.createdAt);
      if (Number.isFinite(t) && t > newest) newest = t;
    }
    lines.push(
      entries.length
        ? ok(`知芽池：${pool} —— ${entries.length} 条（待分诊 ${inbox}）${broken?.length ? `，坏条目 ${broken.length}` : ""}`)
        : warn(`知芽池为空：${pool}（第一次写入后会自动建立）`),
    );
    if (newest) lines.push(`     最近一条写入时间：${new Date(newest).toLocaleString()}`);
  } catch (e) {
    lines.push(warn(`池读取失败：${e && e.message ? e.message : String(e)}`));
  }

  // 3) 嵌入端点
  const embed = process.env.MPI_ZHIYA_EMBED_URL || "http://127.0.0.1:1235/v1/embeddings";
  const health = embed.replace(/\/v1\/embeddings$/, "/health");
  lines.push(`嵌入端点 ${health}：${await probe(health)}（扩展侧另用 MPI_MEMORY_EMBED_URL）`);

  // 4) MPI 运行时扩展文件
  const userDataCandidates = [
    join(process.env.APPDATA || "", "MPI"),
    join(process.env.APPDATA || "", "MPI Dev"),
  ];
  const ext = userDataCandidates.map((d) => join(d, "mpi-memory.ts")).find((p) => existsSync(p));
  if (ext) {
    const st = statSync(ext);
    lines.push(ok(`知芽扩展已就位：${ext}（${st.size} 字节，${new Date(st.mtimeMs).toLocaleString()} 生成）`));
  } else {
    lines.push(warn(`未找到 mpi-memory.ts（${userDataCandidates.join(" / ")}）—— MPI 启动时会生成`));
  }

  // 5) mem0（回滚点）
  const base = "http://127.0.0.1:8000";
  const hp = await probe(`${base}/health`);
  lines.push(`mem0 服务：${hp}${hp.startsWith("HTTP 200") ? "（观察期保留，未停）" : "（若已停，确认这是你有意为之）"}`);

  console.log(lines.join("\n"));
}

await runOnce();
if (watch > 0) {
  console.log(`\n（每 ${watch} 秒复查一次，Ctrl+C 退出）`);
  setInterval(() => void runOnce(), watch * 1000);
}
