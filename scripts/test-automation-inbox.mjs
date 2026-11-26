// 定时任务起草 inbox（schedule-inbox.ts）单测。
//
// 边界比功能重要：agent 起草的任务**必须**落成未启用状态，否则等于让 agent
// 在无人值守下给自己排活；沙盒会话不能借起草升权到 full。
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./electron-stub-loader.mjs", import.meta.url));
const { scheduleInboxDir, ensureScheduleInboxDir, ingestScheduleInbox } = await import(
  "../src/main/schedule-inbox.ts"
);

let checks = 0;
const ok = (label) => {
  checks++;
  return label;
};

const configDir = mkdtempSync(join(tmpdir(), "mpi-sched-inbox-"));
const dir = ensureScheduleInboxDir(configDir);

function drop(name, payload) {
  writeFileSync(join(dir, name), typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
}

function baseDraft(over = {}) {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    name: "每日晨报",
    cwd: "E:\\MyWorkspace\\Project\\MPI",
    prompt: "生成今日晨报",
    schedule: { frequency: "daily", time: "09:00" },
    enabled: true, // 故意写 true：消费后必须被强制成 false
    permission: "full",
    draft: true,
    ...over,
  };
}

try {
  // ---- 空目录 ----
  assert.deepEqual(ingestScheduleInbox(configDir, []), { added: [], rejected: 0 }, ok("空 inbox 返回空结果"));
  assert.equal(scheduleInboxDir(configDir).endsWith("automation-inbox"), true, ok("inbox 路径在 configDir 下"));

  // ---- 正常草稿：enabled 被强制为 false ----
  const t1 = baseDraft();
  drop(`${t1.id}.json`, t1);
  const r1 = ingestScheduleInbox(configDir, []);
  assert.equal(r1.added.length, 1, ok("消费一条草稿"));
  const added = r1.added[0];
  assert.equal(added.enabled, false, ok("落地时强制 enabled=false（agent 不能自我启用）"));
  assert.equal(added.draft, true, ok("保留 draft 标记（面板显示待确认）"));
  assert.equal(added.name, t1.name, ok("名称保留"));
  assert.equal(added.schedule.frequency, "daily", ok("调度保留"));
  assert.equal(added.schedule.time, "09:00", ok("时刻保留"));
  // 文件被消费掉
  assert.equal(readdirSync(dir).length, 0, ok("消费后 inbox 文件被删除"));

  // ---- 沙盒会话不能升权到 full？权限由扩展给定，但主进程再兜一次 ----
  const t2 = baseDraft({ permission: "full" });
  drop(`${t2.id}.json`, t2);
  const r2 = ingestScheduleInbox(configDir, [added]);
  assert.equal(r2.added[0].permission, "full", ok("full 保留（扩展侧已按会话档位限制）"));
  const t3 = baseDraft({ permission: "sandbox" });
  drop(`${t3.id}.json`, t3);
  const r3 = ingestScheduleInbox(configDir, [...r2.added]);
  assert.equal(r3.added[0].permission, "sandbox", ok("sandbox 保留"));
  const t3b = baseDraft({ permission: "weird" });
  drop(`${t3b.id}.json`, t3b);
  const r3b = ingestScheduleInbox(configDir, []);
  assert.equal(r3b.added[0].permission, "sandbox", ok("未知权限归为 sandbox（不放宽）"));

  // ---- 重复 id：不重复添加，文件删掉 ----
  const dup = baseDraft({ id: "task-dup-fixed" });
  drop("a.json", dup);
  const existing = [dup].map((d) => ({ ...d, enabled: false }));
  const before = readdirSync(dir).length;
  const r4 = ingestScheduleInbox(configDir, existing);
  assert.equal(r4.added.length, 0, ok("已存在的 id 不重复添加"));
  assert.equal(readdirSync(dir).length, before - 1, ok("重复投递的文件也被消费掉"));

  // ---- 非法项：丢弃并计数 ----
  drop("bad-json.json", "{ this is not json");
  drop("no-id.json", { name: "x", cwd: "c", prompt: "p", schedule: { frequency: "daily", time: "09:00" } });
  drop("bad-freq.json", baseDraft({ schedule: { frequency: "yearly" } }));
  drop("bad-id-shape.json", baseDraft({ id: "not-a-task-id" }));
  const r5 = ingestScheduleInbox(configDir, []);
  assert.equal(r5.added.length, 0, ok("非法项一条都不添加"));
  assert.equal(r5.rejected, 4, ok("非法项计数为 4"));
  assert.equal(readdirSync(dir).length, 0, ok("非法文件也被清掉（不堆着）"));

  // ---- 各频率的字段校验 ----
  drop("i1.json", baseDraft({ schedule: { frequency: "interval" } }));
  assert.equal(ingestScheduleInbox(configDir, []).rejected, 1, ok("interval 缺 intervalMinutes → 拒"));
  drop("i2.json", baseDraft({ schedule: { frequency: "interval", intervalMinutes: 5 } }));
  assert.equal(ingestScheduleInbox(configDir, []).rejected, 1, ok("interval 小于 15 → 拒"));
  drop("i3.json", baseDraft({ schedule: { frequency: "interval", intervalMinutes: 30 } }));
  const i3 = ingestScheduleInbox(configDir, []);
  assert.equal(i3.added[0].schedule.intervalMinutes, 30, ok("interval 合法可入"));

  drop("o1.json", baseDraft({ schedule: { frequency: "once", onceAt: "2027-01-01T10:00" } }));
  const o1 = ingestScheduleInbox(configDir, []);
  assert.equal(o1.added[0].schedule.onceAt, "2027-01-01T10:00", ok("once 合法可入"));

  drop("w1.json", baseDraft({ schedule: { frequency: "weekly", time: "08:00", days: [5, 1, 1, 9] } }));
  const w1 = ingestScheduleInbox(configDir, []);
  assert.deepEqual(w1.added[0].schedule.days, [1, 5], ok("weekly days 去重排序并剔除非法值"));

  drop("h1.json", baseDraft({ schedule: { frequency: "hourly", minute: 60 } }));
  assert.equal(ingestScheduleInbox(configDir, []).rejected, 1, ok("hourly minute=60 → 拒"));

  // ---- 名字/提示词为空 → 拒 ----
  drop("n1.json", baseDraft({ name: "   " }));
  assert.equal(ingestScheduleInbox(configDir, []).rejected, 1, ok("空名称 → 拒"));
  drop("n2.json", baseDraft({ prompt: "" }));
  assert.equal(ingestScheduleInbox(configDir, []).rejected, 1, ok("空提示词 → 拒"));

  // ---- 目录不存在时不抛 ----
  const missingDirConfig = join(configDir, "does-not-exist");
  assert.deepEqual(
    ingestScheduleInbox(missingDirConfig, []),
    { added: [], rejected: 0 },
    ok("inbox 目录不存在时返回空结果不抛"),
  );
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

console.log(`automation-inbox ok (${checks} 项断言通过)`);
