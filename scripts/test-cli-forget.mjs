/**
 * memory-cli 的 forget / archive 子命令测试
 *
 * 为什么单独测：归档是**改动真相源**的操作，行为契约必须钉住——
 *   ① 前缀歧义**不许猜**（匹配多条就列出来让人挑）
 *   ② --dry 只预览、不落盘
 *   ③ 真归档后条目离开池子、文件进归档目录（跨卷安全路径由面板执行器负责）
 *   ④ 归档目录走 archiveDirFor（母版配置/显式覆盖）
 *   ⑤ archive 是 forget 的同义词；用法文本里能看到
 *
 * 隔离：用临时池（MPI_ZHIYA_POOL_DIR）+ 临时归档目录（MPI_ZHIYA_ARCHIVE_DIR），
 * **绝不碰真实池与真实归档目录**。
 *
 * 运行：npm run test:forget
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { decideIngest, listEntries } = await import("../src/main/zhiya/pool.ts");

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ✅ ${m}`);
};

const root = mkdtempSync(join(tmpdir(), "mpi-cli-forget-"));
const pool = join(root, "pool");
const archive = join(root, "archive");
mkdirSync(pool, { recursive: true });
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// 造三条（用 () => 0 相似度，避免互相判重合并）
const mk = (text) =>
  decideIngest(pool, { text, type: "semantic", temporal: "retrospective", importance: 6, relevance: 0.7, project: "MPI", source: "test" }, () => 0).entry;
const a = mk("归档测试条目甲：这条会被前缀歧义拦下，不该被删。");
const b = mk("归档测试条目乙：这条用来验证 --dry 与真归档。");
const c = mk("归档测试条目丙：另一条无关内容。");
assert.equal(listEntries(pool).entries.length, 3, "三条已就位");

const env = { ...process.env, MPI_ZHIYA_POOL_DIR: pool, MPI_ZHIYA_ARCHIVE_DIR: archive };
const cli = (args) => {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/memory-cli.mjs", ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || ""), err: String(e.stderr || "") };
  }
};

// ① 前缀歧义：不许猜
{
  const r = cli(["forget", "01M"]);
  assert.notEqual(r.code, 0, "歧义应非零退出");
  assert.ok(r.out.includes("匹配到") && r.out.includes("不会猜"), `应说明歧义并拒绝：${r.out.slice(0, 120)}`);
  assert.equal(listEntries(pool).entries.length, 3, "歧义时池子不得变动");
  ok("前缀歧义：列出候选并拒绝动手（池子不变）");
}

// ② 找不到
{
  const r = cli(["forget", "绝对不存在的关键词zzz"]);
  assert.notEqual(r.code, 0, "找不到应非零退出");
  assert.ok(r.err.includes("没找到"), `应提示找不到：${r.err.slice(0, 90)}`);
  assert.equal(listEntries(pool).entries.length, 3);
  ok("找不到匹配：报错退出，池子不变");
}

// ③ --dry：只预览
{
  const r = cli(["forget", b.id, "--dry"]);
  assert.equal(r.code, 0, "dry 应成功退出");
  assert.ok(r.out.includes("--dry 预览"), "应说明是预览");
  assert.equal(listEntries(pool).entries.length, 3, "dry 不得落盘");
  assert.ok(!existsSync(archive) || readdirSync(archive).length === 0, "dry 不得往归档目录写东西");
  ok("--dry：只打印将归档的条目与目标目录，不落盘");
}

// ④ 真归档（用 archive 别名，验证同义词）
{
  const r = cli(["archive", b.id]);
  assert.equal(r.code, 0, `归档应成功：${r.err.slice(0, 120)}`);
  assert.ok(r.out.includes("已归档 1/1"), `应报告归档条数：${r.out.slice(0, 120)}`);
  const left = listEntries(pool).entries;
  assert.equal(left.length, 2, "池内应少一条");
  assert.ok(!left.some((e) => e.id === b.id), "被归档的条目不得留在池内");
  const files = existsSync(archive) ? readdirSync(archive) : [];
  assert.ok(files.some((f) => f.includes(b.id)), `归档目录里应有该条：${files.join(", ")}`);
  assert.equal(files.length, 1, "归档目录只应有这一条");
  ok("archive 别名 = forget：条目离开池子、文件进归档目录（归档 ≠ 删除）");
}

// ⑤ 按正文关键词也能定位；用法文本含两个命令
{
  const r = cli(["forget", "另一条无关内容", "--dry"]);
  assert.equal(r.code, 0, "按正文关键词应能定位");
  assert.ok(r.out.includes(c.id), `应定位到条目丙：${r.out.slice(0, 160)}`);
  const help = cli(["nonsense-command"]);
  assert.ok(help.out.includes("forget") && help.out.includes("archive"), `用法文本应列出两个命令：${help.out.slice(0, 160)}`);
  ok("按正文关键词定位；用法文本列出 forget 与 archive");
}

console.log(`\ntest:forget 全部通过（${n} 项）`);
void a;
