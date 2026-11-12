/**
 * 安装包里的 local-relay 必须**自足**：打包清单要覆盖 index.mjs 的全部相对依赖。
 *
 * 起因（minibox 2026-11-05 来信）：v0.14.6 起安装包 `resources/relay/` 没有 account.mjs，
 * 而 index.mjs 静态 import 它——模块解析先于任何代码执行，子进程启动即 ERR_MODULE_NOT_FOUND，
 * 局域网配对 / 附件下载一起没（`RELAY_ACCOUNT_DISABLED=1` 也救不了）。当时漏它只是因为
 * 新增文件时没人回头补 package.json 的 extraResources filter，而 dev 直接跑仓库里那份、
 * 永远复现不出来。这里钉四条：
 *   ① index.mjs 的每个相对 `.mjs` 依赖都在打包 filter 里，且文件真实存在；
 *   ② 裸包依赖（ws）有自己那条 extraResources；
 *   ③ 账号 API 装载失败（数据目录不可写）时中继照样 ready，只 `/acct/*` 退化为 404；
 *   ④ 数据目录可写时 `/acct/*` 真的挂上（未带令牌回 401，不是 404）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const RELAY_DIR = join(ROOT, "mobile", "relay");
const RELAY_ENTRY = join(RELAY_DIR, "index.mjs");

/** package.json 里 `mobile/relay → relay` 那条 extraResources。 */
function relayResource() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const entries = pkg.build?.extraResources ?? [];
  const relay = entries.find((e) => String(e.from).replace(/\\/g, "/") === "mobile/relay");
  assert.ok(relay, "package.json 里应有 mobile/relay → relay 的 extraResources 条目");
  return { filter: relay.filter ?? [], entries };
}

/** 一个 .mjs 里所有相对依赖（静态 import / export from、动态 import）。 */
function relativeImportsOf(file) {
  const source = readFileSync(file, "utf8");
  const found = new Set();
  const patterns = [/from\s+["'](\.{1,2}\/[^"']+\.mjs)["']/g, /import\(\s*["'](\.{1,2}\/[^"']+\.mjs)["']\s*\)/g];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) found.add(match[1]);
  }
  return [...found];
}

// ---- ① / ② 打包清单覆盖度（回归本体：这次漏的就是这条没守住）----
{
  const { filter, entries } = relayResource();
  const sources = ["index.mjs", ...filter.filter((f) => f.endsWith(".mjs"))].map((f) => join(RELAY_DIR, f));
  const deps = new Map(); // 依赖名 -> 由哪个源文件引入
  for (const file of sources) {
    assert.ok(existsSync(file), `要打进包里的 ${basename(file)} 在仓库里不存在`);
    for (const spec of relativeImportsOf(file)) {
      const name = basename(spec);
      deps.set(name, basename(file));
      assert.ok(
        existsSync(join(RELAY_DIR, name)),
        `${basename(file)} 里 import 了 ./${name}，但仓库里没有这个文件`,
      );
    }
  }
  for (const [name, from] of deps) {
    assert.ok(
      filter.includes(name),
      `${name} 被 ${from} 引用，却不在 mobile/relay 的 extraResources filter ${JSON.stringify(filter)} 里——` +
        "打包版会缺文件（v0.14.6 漏 account.mjs 导致 local-relay 起不来，就是这个断言当初没写）",
    );
  }
  // index.mjs 直接 `import … from "ws"`；它靠单独一条 extraResources（node_modules/ws → relay/node_modules/ws）。
  assert.match(readFileSync(RELAY_ENTRY, "utf8"), /from "ws"/, "index.mjs 不应默默去掉 ws 依赖（下面那条断言的前提）");
  assert.ok(
    entries.some((e) => String(e.from).replace(/\\/g, "/") === "node_modules/ws" && /relay/.test(String(e.to))),
    "ws 必须作为 relay/node_modules/ws 一起打进包（中继子进程按 resources/relay 解析模块）",
  );
  console.log(`  ① 打包清单覆盖 ${deps.size} 个相对依赖：${[...deps.keys()].join(", ")}`);
}

// ---- ③ / ④ 账号 API 装载失败不得拖垮中继（另一半防线）----
/** 起一个中继子进程，等 ready 行；resolve { port, output, child }。 */
function startRelay(env) {
  const child = spawn(process.execPath, [RELAY_ENTRY], {
    env: { ...process.env, RELAY_PORT: "0", RELAY_HOST_TOKENS: "", RELAY_PING_MS: "500", RELAY_DEAD_MS: "1000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`中继 8s 内没起来：\n${output}`)), 8_000);
    const onData = (chunk) => {
      output += String(chunk);
      const match = /ready (?:ws|wss):\/\/\S+?:(\d+)\/ws/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), output });
      }
    };
    // 注意：account 装载失败只打 WARN，ready 仍会到——所以要等 ready，不能拿首行当信号。
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`中继提前退出 code=${code}：\n${output}`));
    });
  });
  return { ready, child };
}

async function getStatus(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.status;
}

const tmpRoot = mkdtempSync(join(tmpdir(), "mpi-relay-pack-"));

test("账号数据目录不可写时，中继仍然 ready（/acct/* 退化为未挂载）", async () => {
  // 把数据目录的父路径设成一个**普通文件** → mkdirSync 必抛 ENOTDIR，稳定复现「构造就失败」。
  const dir = mkdtempSync(join(tmpRoot, "unwritable-"));
  writeFileSync(join(dir, "not-a-dir"), "x");
  const running = startRelay({ RELAY_ACCOUNT_DIR: join(dir, "not-a-dir", "account") });
  const { port, output } = await running.ready;
  assert.match(output, /WARN account api 未挂载/, `装载失败应当留下告警，实际输出：\n${output}`);
  assert.equal(await getStatus(port, "/healthz"), 200, "主链路（健康检查）不受账号模块影响");
  assert.equal(await getStatus(port, "/acct/me"), 404, "未挂载时 /acct/* 应是不存在，而不是别的状态码");
  running.child.kill();
});

test("账号数据目录可写时，/acct/* 真的挂上（未带令牌回 401）", async () => {
  const dir = mkdtempSync(join(tmpRoot, "acct-"));
  const running = startRelay({ RELAY_ACCOUNT_DIR: dir });
  const { port, output } = await running.ready;
  assert.doesNotMatch(output, /WARN account api 未挂载/, `这次应当装载成功：\n${output}`);
  assert.equal(existsSync(join(dir, "blobs")), true, "AccountStore 会建 blobs 子目录（证明文件确实被加载并构造）");
  assert.equal(await getStatus(port, "/acct/me"), 401, "挂载后未带令牌应是 401 NOT_AUTHENTICATED");
  running.child.kill();
});

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
