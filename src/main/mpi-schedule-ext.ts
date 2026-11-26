/**
 * MPI 定时任务 bridge for pi（通过 --extension 加载，见 schedule-extension.ts）。
 *
 * 只做一件事：让 agent 在对话里**起草**一个定时任务。
 *
 * 关键约束（为什么不是直接写 config.json）：
 *   1. 主进程是 config.json 的唯一写者。跨进程直写会和调度器的
 *      reloadConfig/patchTask 抢同一份文件（后者是「读-改-写整份」，会覆盖）。
 *      所以这里只往 inbox 目录丢一个 JSON 文件，主进程消费后才真正落盘。
 *   2. agent 起草 **不等于** 用户同意。入库时任务默认 enabled=false，面板里
 *      显示为「草稿·待确认」；用户点「启用」才算数。否则等于让 agent 在无人
 *      值守下给自己排活。
 *   3. 沙盒会话不允许起草 full 权限任务——那等于绕过权限门禁给自己升权。
 *
 * Env（由 pi-bridge 在 spawn 时注入）：
 *   MPI_SCHEDULE_INBOX_DIR  绝对路径，<configDir>/automation-inbox/
 *   MPI_SCHEDULE_PERMISSION 当前会话的权限档（sandbox / full）
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const INBOX_DIR = process.env.MPI_SCHEDULE_INBOX_DIR || "";
const SESSION_PERMISSION = process.env.MPI_SCHEDULE_PERMISSION === "full" ? "full" : "sandbox";

function configured(): boolean {
  return !!INBOX_DIR;
}

const ScheduleParams = Type.Object({
  name: Type.String({ description: "任务名称（短，例：每日晨报）" }),
  prompt: Type.String({ description: "到点要执行的完整指令；可用技能与斜杠命令" }),
  frequency: Type.Union(
    [
      Type.Literal("hourly"),
      Type.Literal("daily"),
      Type.Literal("weekly"),
      Type.Literal("interval"),
      Type.Literal("once"),
    ],
    { description: "调度频率：hourly=每小时某分钟，daily=每天某时刻，weekly=每周某几天，interval=每 N 分钟，once=只跑一次" },
  ),
  minute: Type.Optional(Type.Number({ description: "hourly：每小时第几分钟（0-59）" })),
  time: Type.Optional(Type.String({ description: 'daily/weekly：本地时刻 "HH:MM"（24 小时制）' })),
  days: Type.Optional(
    Type.Array(Type.Number(), { description: "weekly：星期几，0=周日 .. 6=周六" }),
  ),
  intervalMinutes: Type.Optional(Type.Number({ description: "interval：间隔分钟数，最小 15" })),
  onceAt: Type.Optional(Type.String({ description: 'once：本地时刻 "YYYY-MM-DDTHH:MM"' })),
  cwd: Type.Optional(
    Type.String({ description: "任务运行的工作目录；省略 = 当前会话的工作目录" }),
  ),
});

/** 校验并归一化调度参数；返回错误信息或干净的 schedule。 */
function buildSchedule(params: {
  frequency: string;
  minute?: number;
  time?: string;
  days?: number[];
  intervalMinutes?: number;
  onceAt?: string;
}): { ok: true; schedule: Record<string, unknown> } | { ok: false; error: string } {
  const hourMinute = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  };

  if (params.frequency === "hourly") {
    const minute = params.minute;
    if (typeof minute !== "number" || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      return { ok: false, error: "hourly 需要 minute（0-59 的整数）" };
    }
    return { ok: true, schedule: { frequency: "hourly", minute } };
  }

  if (params.frequency === "interval") {
    const step = params.intervalMinutes;
    if (typeof step !== "number" || !Number.isInteger(step) || step < 15) {
      return { ok: false, error: "interval 需要 intervalMinutes（≥ 15 的整数）" };
    }
    return { ok: true, schedule: { frequency: "interval", intervalMinutes: step } };
  }

  if (params.frequency === "once") {
    if (typeof params.onceAt !== "string") return { ok: false, error: 'once 需要 onceAt（"YYYY-MM-DDTHH:MM"）' };
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(params.onceAt.trim());
    if (!m) return { ok: false, error: 'onceAt 格式应为 "YYYY-MM-DDTHH:MM"' };
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
    if (at.getMonth() !== Number(m[2]) - 1 || at.getDate() !== Number(m[3])) {
      return { ok: false, error: "onceAt 日期不存在（例如 2 月 31 日）" };
    }
    if (at.getTime() <= Date.now()) return { ok: false, error: "onceAt 必须是未来时刻" };
    return { ok: true, schedule: { frequency: "once", onceAt: params.onceAt.trim() } };
  }

  const time = hourMinute(params.time);
  if (!time) return { ok: false, error: `${params.frequency} 需要 time（"HH:MM"，24 小时制）` };

  if (params.frequency === "daily") {
    return { ok: true, schedule: { frequency: "daily", time } };
  }

  if (params.frequency === "weekly") {
    const days = Array.isArray(params.days)
      ? params.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
    if (!days.length) return { ok: false, error: "weekly 需要 days（0=周日 .. 6=周六，至少一个）" };
    return { ok: true, schedule: { frequency: "weekly", time, days: [...new Set(days)].sort((a, b) => a - b) } };
  }

  return { ok: false, error: `未知的频率：${params.frequency}` };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mpi_schedule_task",
    label: "Schedule Task",
    description:
      "在 MPI 的定时任务面板里起草一个任务（需要用户在面板里点「启用」后才生效，不是直接创建）。" +
      "只在用户明确要求「以后定期帮我做某事」时使用；一次性的即时动作不要用它。" +
      "沙盒会话无法起草完全权限任务。",
    parameters: ScheduleParams,
    async execute(_toolCallId, params) {
      if (!configured()) {
        return {
          content: [{ type: "text", text: "MPI 定时任务接口不可用（未注入 inbox 目录），无法起草。" }],
          isError: true,
        };
      }

      const built = buildSchedule(params as Parameters<typeof buildSchedule>[0]);
      if (!built.ok) {
        return { content: [{ type: "text", text: `调度参数有误：${built.error}` }], isError: true };
      }

      const name = String(params.name || "").trim();
      if (!name) {
        return { content: [{ type: "text", text: "任务名称不能为空。" }], isError: true };
      }
      const prompt = String(params.prompt || "").trim();
      if (!prompt) {
        return { content: [{ type: "text", text: "提示词不能为空。" }], isError: true };
      }

      const draft = {
        id: `task-${randomUUID()}`,
        name: name.slice(0, 120),
        cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : process.cwd(),
        prompt,
        schedule: built.schedule,
        // 关键：起草状态。用户必须在面板里点「启用」，否则永远不会被调度器执行。
        enabled: false,
        // 权限跟随当前会话，不允许 agent 自我升权。
        permission: SESSION_PERMISSION,
        draft: true,
        createdBy: "agent",
        createdAt: Date.now(),
      };

      try {
        mkdirSync(INBOX_DIR, { recursive: true });
        writeFileSync(join(INBOX_DIR, `${draft.id}.json`), JSON.stringify(draft, null, 2), "utf8");
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `写入草稿失败：${e?.message || e}` }],
          isError: true,
        };
      }

      const summary = describe(built.schedule);
      return {
        content: [
          {
            type: "text",
            text:
              `已在 MPI 定时任务面板起草「${name}」（${summary}），状态为**未启用**。\n` +
              `请告诉用户：需要在「定时任务」面板里检查并点开关启用后才会真正执行；` +
              `权限沿用当前会话的 ${SESSION_PERMISSION === "full" ? "完全权限" : "沙盒"}。`,
          },
        ],
      };
    },
  });
}

/** 与主进程 automation-schedule 的 describeSchedule 保持同义（扩展侧不能 import 它）。 */
function describe(schedule: Record<string, unknown>): string {
  const freq = String(schedule.frequency || "");
  if (freq === "hourly") return `每小时第 ${schedule.minute ?? 0} 分钟`;
  if (freq === "interval") return `每 ${schedule.intervalMinutes ?? 0} 分钟`;
  if (freq === "once") return `一次：${schedule.onceAt ?? "—"}`;
  if (freq === "daily") return `每天 ${schedule.time ?? "—"}`;
  if (freq === "weekly") {
    const names = ["日", "一", "二", "三", "四", "五", "六"];
    const days = (Array.isArray(schedule.days) ? schedule.days : []).map((d) => names[Number(d)] ?? "?").join("、");
    return `每周 ${days || "—"} ${schedule.time ?? "—"}`;
  }
  return freq || "—";
}
