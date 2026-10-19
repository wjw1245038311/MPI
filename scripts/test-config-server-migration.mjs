/**
 * 「服务器」配置迁移必须是**一次性**的（2026-10-19 真机）。
 *
 * 症状：用户在 maxbox 上清空「自定义中继」并保存，重启 MPI 后又变回「自定义中继 ☑」，
 * 地址还是旧的 `wss://aliyun-ecs…:9443/ws` —— 看起来像「保存没生效」。
 *
 * 根因：config.ts 的旧配置迁移**每次启动都跑**：只要 `customRelayUrl` 为空，就从
 * `remoteRelayUrl` / 老通道列表里把它还原回去。于是「清空」永远被下一次启动撤销。
 *
 * 契约（本测试钉住）：
 *   1. 旧配置首次加载：迁移生效，并把 `serverMigration: 2` 落盘；
 *   2. 用户清空自定义中继后再次加载：**不得**再被旧字段还原；
 *   3. 已标记过的配置即使残留旧字段，也不再迁移。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { loadConfig, updateConfig } = await import("../src/main/config.ts");

const LEGACY = "wss://legacy-relay.example.com/ws";

// 1) 旧配置：只有 remoteRelayUrl，没有 customRelayUrl / serverMigration
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-cfg-mig-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ remoteRelayUrl: LEGACY, language: "zh" }, null, 2));
  const first = loadConfig(dir);
  assert.equal(first.customRelayUrl, LEGACY, "首次加载：应从旧字段迁移出自定义中继");
  assert.equal(first.serverMigration, 2, "迁移跑完要打标记");
  const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(onDisk.serverMigration, 2, "标记必须**立刻落盘**（用户可能再也不点保存）");
  // 注意：remoteRelayUrl 仍是**在用**字段（本机/局域网中继地址），迁移不会删它；
  // 靠 serverMigration 标记保证「不会被反复当成自定义中继还原」。
  assert.equal(typeof onDisk.remoteRelayUrl, "string", "在用字段保留");
}

// 2) 清空自定义中继 → 再启动不得被还原
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-cfg-mig-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ remoteRelayUrl: LEGACY }, null, 2));
  loadConfig(dir); // 第一次：迁移 + 落盘
  updateConfig({ customRelayUrl: "", customRelayToken: "" }); // 用户取消自定义中继并保存
  const second = loadConfig(dir);
  assert.ok(!second.customRelayUrl, "清空后重启不能又冒出旧地址（这正是真机症状）");
  assert.equal(second.serverMigration, 2);
}

// 3) 已标记的配置：残留旧字段也不再迁移
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-cfg-mig-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ serverMigration: 2, remoteRelayUrl: LEGACY }, null, 2),
  );
  const cfg = loadConfig(dir);
  assert.ok(!cfg.customRelayUrl, "标记为 2 时迁移不再运行");
}

// 4) 正常配置（无旧字段）：不受影响
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-cfg-mig-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ language: "zh" }, null, 2));
  const cfg = loadConfig(dir);
  assert.ok(!cfg.customRelayUrl);
  assert.equal(cfg.serverMigration, 2, "首次加载也会打标记（避免以后误跑）");
}

console.log("config-server-migration：4 组断言全部通过");
