// 「更新这台设备」的指令通道（mpi_update_app）——纯逻辑 + 收件箱巡检。
//
// 背景（2026-11-05 用户需求）：手机端要能控制别的设备更新 MPI。手机只能发对话，所以
// 指令必须落到 agent 身上：扩展写请求进 inbox，主进程（唯一能碰 electron-updater 的
// 一侧）查/下/装，再把回执写回去让模型转述。这里钉死三件事：
//   1. 请求校验（坏 JSON / 缺 id 不能被当成"更新一次"）；
//   2. 请求文件**先删再执行**（更新会重启应用，重复触发毫无意义）；
//   3. 回执文案不能说谎（失败就说失败，不许出现"已更新"式的措辞）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `mpi-update-cmd-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });

const mod = await import("../src/main/update-request.ts");

// ---- 1. 请求校验 -------------------------------------------------------------
{
  assert.deepEqual(mod.normalizeUpdateRequest({ id: "abc123", install: false }), { id: "abc123", install: false });
  assert.deepEqual(
    mod.normalizeUpdateRequest({ id: "abc123" }),
    { id: "abc123", install: true },
    "缺 install 时应默认安装（用户要的是「自动更新」）",
  );
  assert.equal(mod.normalizeUpdateRequest({ id: "" }), null, "没有 id 的请求不能被执行");
  assert.equal(mod.normalizeUpdateRequest({ install: true }), null);
  assert.equal(mod.normalizeUpdateRequest("nonsense"), null);
  assert.equal(mod.normalizeUpdateRequest({ id: "x".repeat(65) }), null, "超长 id 直接拒（防脏文件名）");
  console.log("ok - 请求校验：缺 id / 非对象 / 超长 id 一律拒绝，install 默认 true");
}

// ---- 2. 回执文案（不许说谎） ---------------------------------------------------
{
  const upToDate = mod.updateReceiptText({ id: "a", ok: true, state: "up-to-date", current: "0.14.1" });
  assert.ok(/already up to date/.test(upToDate) && /0\.14\.1/.test(upToDate), "已是最新版要说明并带版本号");
  const downloading = mod.updateReceiptText({ id: "a", ok: true, state: "downloading", current: "0.14.1", latest: "0.14.2" });
  assert.ok(/0\.14\.2/.test(downloading) && /restart/i.test(downloading), "下载中要提到目标版本与重启");
  const failed = mod.updateReceiptText({ id: "a", ok: false, state: "error", current: "0.14.1", message: "ECONNRESET" });
  assert.ok(/failed/.test(failed) && /ECONNRESET/.test(failed), "失败必须说失败并带原因");
  assert.ok(!/up to date/i.test(failed), "失败文案不能出现「已是最新」这类误导");
  assert.ok(/^MPI update failed/.test(failed), "失败文案必须以「update failed」开头（不许粉饰）");
  assert.ok(/install=false/.test(mod.updateReceiptText({ id: "a", ok: true, state: "downloaded", latest: "0.14.2" })));
  assert.ok(/restarting/.test(mod.updateReceiptText({ id: "a", ok: true, state: "installing", latest: "0.14.2" })));
  console.log("ok - 回执文案：五种状态各自准确，失败不含「已更新」措辞");
}

// ---- 3. 收件箱巡检：只认合法 JSON，先删再执行 -----------------------------------
{
  const dirs = mod.ensureUpdateDirs(ROOT);
  assert.ok(existsSync(dirs.inboxDir) && existsSync(dirs.outboxDir), "收件箱/回执目录应自动创建");

  writeFileSync(join(dirs.inboxDir, "good.json"), JSON.stringify({ id: "good", install: true }));
  writeFileSync(join(dirs.inboxDir, "noid.json"), JSON.stringify({ install: true }));
  writeFileSync(join(dirs.inboxDir, "broken.json"), "{ not json");
  writeFileSync(join(dirs.inboxDir, "ignored.txt"), "not a request");

  const handled = [];
  mod.ingestUpdateRequests({ ...dirs, onRequest: (request) => handled.push(request) });
  assert.deepEqual(handled, [{ id: "good", install: true }], "只有合法请求被执行一次");
  assert.ok(!existsSync(join(dirs.inboxDir, "good.json")), "请求文件必须先删掉（否则下一轮巡检会再更新一次）");
  const left = readdirSync(dirs.inboxDir).sort();
  // noid.json 合法 JSON 但缺 id → 被拒并删除（留下它只会每轮都被拒）；半截 JSON 与
  // 非 .json 文件留在原地等下一轮（或 1 分钟后过期清理）。
  assert.deepEqual(left, ["broken.json", "ignored.txt"], "非法请求不能反复触发，半截文件留待下一轮");

  // 半截 JSON 不会让巡检抛错（扩展可能正在写）。
  assert.equal(mod.ingestUpdateRequests({ ...dirs, onRequest: () => { throw new Error("不该被调用"); } }), 0);
  console.log("ok - 巡检：合法请求执行并删除，坏文件跳过且不抛错");
}

// ---- 4. 回执写盘 --------------------------------------------------------------
{
  const dirs = mod.ensureUpdateDirs(ROOT);
  mod.writeUpdateReceipt(dirs, { id: "r1", ok: true, state: "installing", latest: "0.14.2", current: "0.14.1" });
  const onDisk = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(dirs.outboxDir, "r1.json"), "utf8")));
  assert.equal(onDisk.state, "installing");
  assert.equal(onDisk.latest, "0.14.2");
  console.log("ok - 回执写盘：状态与版本号完整");
}

rmSync(ROOT, { recursive: true, force: true });
console.log("✓ test-update-cmd 全部通过");
