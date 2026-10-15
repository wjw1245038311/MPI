/**
 * 统一 JSON 状态文件读写（src/main/json-store.ts）+ 各 store 迁移后的行为守卫。
 *
 * 关注三件事：
 *   1. 落盘是原子的：读者只会看到旧文件或新文件，且不留 .tmp 残渣；
 *   2. 读侧容错：缺失 / 坏 JSON 返回 null，坏文件原地保留供排查；
 *   3. 迁移不改变语义：config / drafts / todos 三条链路仍然按各自格式落盘。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 源码用无扩展名的 bundler 风格导入，这里补上 .ts 让 node 直接跑。
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { readJsonRaw, writeJsonAtomic } = await import("../src/main/json-store.ts");
const { loadConfig, updateConfig } = await import("../src/main/config.ts");
const { flushDrafts, setDraft } = await import("../src/main/draft-store.ts");

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ✓ ${m}`);
};

const dir = mkdtempSync(join(tmpdir(), "mpi-json-store-"));
try {
  // ---------------------------------------------------------------- 单元：写
  const f = join(dir, "state.json");
  writeJsonAtomic(f, { a: 1, b: [1, 2] });
  assert.equal(readFileSync(f, "utf8"), JSON.stringify({ a: 1, b: [1, 2] }), "默认紧凑格式（与历史文件一致）");
  ok("原子写：内容正确、默认紧凑格式");

  // 覆盖写不留临时文件残渣（tmp 名带 pid，rename 后应当消失）
  writeJsonAtomic(f, { a: 2 });
  const leftovers = readdirSync(dir).filter((x) => x.includes(".tmp"));
  assert.deepEqual(leftovers, [], `不应留下 .tmp 残渣：${leftovers.join(", ")}`);
  ok("覆盖写后目录里没有 .tmp 残留");

  // pretty 模式（config.json 用的就是两格缩进）
  const pf = join(dir, "pretty.json");
  writeJsonAtomic(pf, { a: 1 }, { pretty: true });
  assert.equal(readFileSync(pf, "utf8"), '{\n  "a": 1\n}', "pretty 时缩进两格");
  ok("pretty 选项产出两格缩进");

  // 父目录不存在时自动创建
  const nested = join(dir, "sub", "deep", "x.json");
  writeJsonAtomic(nested, { ok: true });
  assert.deepEqual(readJsonRaw(nested), { ok: true }, "自动建父目录");
  ok("父目录缺失时自动创建");

  // ---------------------------------------------------------------- 单元：读
  assert.equal(readJsonRaw(join(dir, "missing.json")), null, "缺失文件返回 null");
  const broken = join(dir, "broken.json");
  writeFileSync(broken, '{"a": ', "utf8"); // 半截 JSON（正是以前直接覆写会留下的样子）
  assert.equal(readJsonRaw(broken), null, "坏 JSON 返回 null");
  assert.ok(existsSync(broken), "坏文件原地保留，不静默删除");
  ok("缺失 / 损坏都返回 null，且坏文件留在原地供排查");

  // Windows「假失败」：rename 抛 EPERM 但目标已写好 → 仍算成功（底座与记忆池共用）
  const { atomicReplace } = await import("../src/main/fs-atomic.ts");
  const fakeDir = mkdtempSync(join(tmpdir(), "mpi-json-fake-eperm-"));
  try {
    const dest = join(fakeDir, "d.json");
    const content = JSON.stringify({ id: "x" });
    writeFileSync(join(fakeDir, "d.json.tmp-999"), content, "utf8");
    atomicReplace(join(fakeDir, "d.json.tmp-999"), dest, content, (t, p) => {
      renameSync(t, p); // 文件真的被移动了……
      const e = new Error("EPERM: operation not permitted");
      e.code = "EPERM";
      throw e; // ……但照样报错（杀软 / 索引器竞态）
    }, 3);
    assert.equal(readFileSync(dest, "utf8"), content, "假失败应判定为成功");
    ok("Windows EPERM 假失败容错（目标已写好 → 不报错）");
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
  }

  // ------------------------------------------------------ 集成：迁移后的 store
  const dataDir = mkdtempSync(join(tmpdir(), "mpi-json-stores-"));
  try {
    loadConfig(dataDir); // 把 config / drafts 指到临时目录

    updateConfig({ language: "zh" });
    const cfg = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    assert.equal(cfg.language, "zh", "config 仍然可读、字段生效");
    assert.ok(readFileSync(join(dataDir, "config.json"), "utf8").startsWith("{\n  "), "config 保持两格缩进");
    ok("config.ts：保存改为原子写后格式与内容不变");

    setDraft("n:/tmp/demo", { text: "草稿", images: [], files: [] });
    flushDrafts();
    assert.deepEqual(readJsonRaw(join(dataDir, "drafts.json")), { "n:/tmp/demo": { text: "草稿", images: [], files: [] } });
    ok("draft-store：草稿照常落盘（紧凑格式）");

    // 坏 drafts.json：启动时读到它应当当空草稿本继续，不抛异常、不连带其它文件
    writeFileSync(join(dataDir, "drafts.json"), "{oops", "utf8");
    // 加 query 拿一份新的模块实例（绕过 ESM 缓存），模拟下次启动的首次加载
    const fresh = await import("../src/main/draft-store.ts?corrupt-case=1");
    assert.deepEqual(fresh.getAllDrafts(), {}, "损坏的草稿本按空处理");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).language, "zh", "其它文件不受牵连");
    ok("损坏文件只影响自己，不扩散到别的状态文件");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\njson-store 测试通过：${n} 项`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
