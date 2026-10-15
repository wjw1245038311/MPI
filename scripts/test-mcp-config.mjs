/**
 * MCP 配置层（src/main/plugins.ts）——切到 pi 内建 MCP 后的读写守卫。
 *
 * 背景（都在 pi.exe 1.2.0 上实测过）：
 *   - pi ≥ 0.99 自带内建 MCP，启用标记是 `enabled`；旧版 MPI 写的 `disabled: true`
 *     会被**忽略并照常连接**（禁用静默失效）；
 *   - pi-mcp-adapter 一加载就往 settings.json 写 `-builtin:mcp` 顶掉内建，所以摘掉
 *     adapter 与清 token 必须成对做。
 * 这里用 PI_AGENT_DIR 指向临时目录，不碰真实的 ~/.pi/agent。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "mpi-mcp-config-"));
process.env.PI_AGENT_DIR = agentDir.replace(/^\//, ""); // Windows 路径给 pi/session-store 用

// plugins.ts 会拉到 runtime-package（依赖 electron），这个 loader 同时把 electron
// 换成桩、并给无扩展名导入补 .ts 后缀。
register(new URL("./electron-stub-loader.mjs", import.meta.url));
const { listMcpServers, normalizeMcpDisabledFlags, setMcpServerEnabled, migrateToBuiltinMcp, piHasBuiltinMcp } = await import(
  "../src/main/plugins.ts"
);

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ✓ ${m}`);
};

const MCP = join(agentDir, "mcp.json");
const SETTINGS = join(agentDir, "settings.json");
const writeMcp = (obj) => writeFileSync(MCP, JSON.stringify(obj, null, 2) + "\n", "utf8");
const readMcp = () => JSON.parse(readFileSync(MCP, "utf8"));

try {
  // ---------------------------------------------------------------- 读取兼容
  writeMcp({
    mcpServers: {
      "legacy-disabled": { command: "npx", args: ["a"], disabled: true },
      "builtin-off": { url: "https://example.invalid/mcp", enabled: false },
      normal: { command: "node", args: ["s.js"], exposure: "direct", oauth: { clientName: "MPI" } },
    },
    someOtherKey: { keep: true },
  });

  const listed = listMcpServers();
  assert.deepEqual(
    Object.fromEntries(listed.map((s) => [s.name, s.enabled])),
    { "legacy-disabled": false, "builtin-off": false, normal: true },
    "旧字段 disabled:true 与新字段 enabled:false 都要读成禁用",
  );
  assert.equal(listed.find((s) => s.name === "normal").exposure, "direct", "exposure 透传给面板显示");
  ok("读取：disabled(旧) / enabled:false(新) 都算禁用，exposure 可见");

  // ------------------------------------------------------------ 归一化写回
  const changed = normalizeMcpDisabledFlags();
  assert.equal(changed, 1, "只有带遗留字段的条目计数（normal 没有 disabled）");
  const after = readMcp().mcpServers["legacy-disabled"];
  assert.deepEqual(after, { command: "npx", args: ["a"], enabled: false }, "disabled:true → enabled:false，其余字段不动");
  assert.equal(readMcp().someOtherKey.keep, true, "顶层其它键原样保留");
  assert.equal(normalizeMcpDisabledFlags(), 0, "再跑一次是幂等的（不再写盘）");
  ok("归一化：改写为 enabled:false、保留未知键、二次调用不写盘");

  // disabled:false 这种噪声应当直接删掉（等价于启用）
  writeMcp({ mcpServers: { x: { command: "c", disabled: false } } });
  assert.equal(normalizeMcpDisabledFlags(), 1);
  assert.deepEqual(readMcp().mcpServers.x, { command: "c" }, "disabled:false 直接清除，不落 enabled 键");
  ok("归一化：disabled:false 噪声被清掉");

  // ---------------------------------------------------------------- 开关写入
  writeMcp({
    mcpServers: { y: { command: "c", args: ["z"], env: { A: "1" }, disabled: true }, z: { url: "https://e/mcp" } },
  });
  setMcpServerEnabled("y", true);
  assert.deepEqual(readMcp().mcpServers.y, { command: "c", args: ["z"], env: { A: "1" } }, "启用 = 删键（与 pi /mcp 写法一致）");
  setMcpServerEnabled("z", false);
  assert.deepEqual(readMcp().mcpServers.z, { url: "https://e/mcp", enabled: false }, "禁用写 enabled:false，不再写 disabled");
  assert.ok(!JSON.stringify(readMcp()).includes("disabled"), "文件里不应再出现 disabled");
  ok("写入：启用删键、禁用写 enabled:false，且不再产生 disabled");

  // -------------------------------------------------------- settings.json 迁移
  writeFileSync(
    SETTINGS,
    JSON.stringify(
      { defaultModel: "m@p", packages: ["npm:pi-mcp-adapter", "npm:pi-mcp-market", "npm:other-ext"], extensions: ["-builtin:mcp", "./my.ts"], skills: ["/s"] },
      null,
      2,
    ),
    "utf8",
  );
  const mig = migrateToBuiltinMcp("1.2.0");
  assert.deepEqual(mig, { removedAdapter: true, removedMarket: true, removedFlag: true });
  const st = JSON.parse(readFileSync(SETTINGS, "utf8"));
  assert.deepEqual(st.packages, ["npm:other-ext"], "两个第三方 MCP 包都摘掉，其它包保留");
  assert.deepEqual(st.extensions, ["./my.ts"], "只删 -builtin:mcp 这一个 token");
  assert.equal(st.defaultModel, "m@p");
  assert.deepEqual(st.skills, ["/s"]);
  ok("迁移：摘 adapter + 清 -builtin:mcp，无关设置原样保留");

  // 没东西可改时不碰磁盘
  const before = statSync(SETTINGS).mtimeMs;
  const noop = migrateToBuiltinMcp("1.2.0");
  assert.deepEqual(noop, { removedAdapter: false, removedMarket: false, removedFlag: false });
  assert.equal(statSync(SETTINGS).mtimeMs, before, "幂等：无事可做就不写文件");
  ok("迁移：重复调用无副作用（不写盘）");

  // 只有 market（没装 adapter）时也要摘干净
  writeFileSync(SETTINGS, JSON.stringify({ packages: ["npm:pi-mcp-market", "npm:web"] }, null, 2), "utf8");
  const onlyMarket = migrateToBuiltinMcp("1.2.0");
  assert.deepEqual(onlyMarket, { removedAdapter: false, removedMarket: true, removedFlag: false });
  assert.deepEqual(JSON.parse(readFileSync(SETTINGS, "utf8")).packages, ["npm:web"], "market 单独存在时也摘掉");
  ok("迁移：只装了 pi-mcp-market 的情况同样摘除（MPI 自己的市场页不依赖它）");

  // packages 清空后不落空数组
  writeFileSync(SETTINGS, JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }, null, 2), "utf8");
  assert.equal(migrateToBuiltinMcp("1.2.0").removedAdapter, true);
  assert.deepEqual(JSON.parse(readFileSync(SETTINGS, "utf8")), {}, "最后一项被摘掉时删除整个键");
  ok("迁移：packages 空了就删键，不给 pi 留噪声");

  // 版本门控：pi < 0.99 没有内建 MCP，这时摘掉 adapter 等于 MCP 直接消失 ⇒ 必须跳过
  writeFileSync(SETTINGS, JSON.stringify({ packages: ["npm:pi-mcp-adapter"], extensions: ["-builtin:mcp"] }, null, 2), "utf8");
  assert.deepEqual(piHasBuiltinMcp("0.87.0"), false, "0.87 无内建 MCP");
  assert.deepEqual(piHasBuiltinMcp("0.99.0"), true, "0.99 起有内建");
  assert.deepEqual(piHasBuiltinMcp("1.2.0"), true, "1.x 有内建");
  assert.deepEqual(piHasBuiltinMcp(null), false, "版本未知当作不支持");
  const skipped = migrateToBuiltinMcp("0.87.0");
  assert.equal(skipped.removedAdapter, false, "旧运行时不动 packages");
  assert.ok(skipped.skipped, "跳过原因可见");
  assert.deepEqual(JSON.parse(readFileSync(SETTINGS, "utf8")), { packages: ["npm:pi-mcp-adapter"], extensions: ["-builtin:mcp"] },
    "跳过时文件保持原样（当前 0.87 环境里 adapter 仍是唯一 MCP 来源）");
  ok("版本门控：pi < 0.99 时不摘 adapter，避免 MCP 直接消失");

  // settings.json 缺失/损坏都不该抛
  rmSync(SETTINGS);
  assert.deepEqual(migrateToBuiltinMcp("1.2.0"), { removedAdapter: false, removedMarket: false, removedFlag: false });
  writeFileSync(SETTINGS, "{oops", "utf8");
  assert.deepEqual(migrateToBuiltinMcp("1.2.0"), { removedAdapter: false, removedMarket: false, removedFlag: false },
    "坏 settings.json 直接跳过，不覆写");
  ok("迁移：settings.json 缺失或损坏时安全跳过（坏文件留给用户排查）");
} finally {
  delete process.env.PI_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
}

console.log(`\nmcp-config 测试通过：${n} 项`);
