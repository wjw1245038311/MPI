import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AutomationTask, TaskSchedule } from "./config";
import { appendDiagLog } from "./diag-log";

/**
 * Agent 起草的定时任务收件箱。
 *
 * agent 侧扩展（mpi-schedule-ext）只往这个目录丢 JSON，主进程是唯一把任务写进
 * config.json 的一方——跨进程直写会与调度器的「读-改-写整份配置」抢文件。
 *
 * 落地的任务**一律 enabled=false**（草稿），必须由用户在面板里点开开关才会被
 * 调度器执行。这是「agent 不能自己给自己排无人值守的活」这条边界的实现点。
 */

const MAX_DRAFTS_PER_SCAN = 20;

export function scheduleInboxDir(configDir: string): string {
  return join(configDir, "automation-inbox");
}

export function ensureScheduleInboxDir(configDir: string): string {
  const dir = scheduleInboxDir(configDir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录已存在或不可写：ingest 时会再判一次 */
  }
  return dir;
}

function sanitizeSchedule(raw: unknown): TaskSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const frequency = s.frequency;
  if (
    frequency !== "hourly" &&
    frequency !== "daily" &&
    frequency !== "weekly" &&
    frequency !== "interval" &&
    frequency !== "once"
  ) {
    return null;
  }
  const out: TaskSchedule = { frequency };
  if (typeof s.minute === "number" && Number.isInteger(s.minute) && s.minute >= 0 && s.minute <= 59) {
    out.minute = s.minute;
  }
  if (typeof s.time === "string" && /^\d{1,2}:\d{2}$/.test(s.time)) out.time = s.time;
  if (Array.isArray(s.days)) {
    const days = s.days.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length) out.days = [...new Set(days)].sort((a, b) => a - b);
  }
  if (typeof s.intervalMinutes === "number" && Number.isInteger(s.intervalMinutes) && s.intervalMinutes >= 15) {
    out.intervalMinutes = s.intervalMinutes;
  }
  if (typeof s.onceAt === "string") out.onceAt = s.onceAt;

  // 必需字段校验：缺了就等于一个「永远不会触发、但面板里看着正常」的任务。
  // 这种静默失效是最难查的（用户以为排上了，实际什么都没干）。
  if (out.frequency === "hourly" && out.minute === undefined) return null;
  if ((out.frequency === "daily" || out.frequency === "weekly") && !out.time) return null;
  if (out.frequency === "weekly" && !out.days?.length) return null;
  if (out.frequency === "interval" && out.intervalMinutes === undefined) return null;
  if (out.frequency === "once" && !out.onceAt) return null;
  return out;
}

function sanitizeDraft(raw: unknown): AutomationTask | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id.startsWith("task-")) return null;
  if (typeof d.name !== "string" || !d.name.trim()) return null;
  if (typeof d.cwd !== "string" || !d.cwd.trim()) return null;
  if (typeof d.prompt !== "string" || !d.prompt.trim()) return null;
  const schedule = sanitizeSchedule(d.schedule);
  if (!schedule) return null;
  const task: AutomationTask = {
    id: d.id,
    name: d.name.trim().slice(0, 120),
    cwd: d.cwd.trim(),
    prompt: d.prompt,
    schedule,
    // 关键：无论 inbox 里写的是什么，落地一律未启用。
    enabled: false,
    // 权限也由扩展按会话档位给定，但这里再兜一次：非 full 一律 sandbox。
    permission: d.permission === "full" ? "full" : "sandbox",
    // 标记为草稿，面板据此显示「待确认」。
    draft: true,
  };
  return task;
}

export interface IngestResult {
  added: AutomationTask[];
  /** 被丢弃的文件（内容非法），调用方可能想提示。 */
  rejected: number;
}

/**
 * 消费 inbox。返回新建的草稿任务（调用方负责写进 config 并通知渲染层）。
 *
 * 重复 id 的任务直接跳过并删掉文件：同一个草稿被投递两次（重试/竞态）不该
 * 在面板里出现两条。
 */
export function ingestScheduleInbox(
  configDir: string,
  existingTasks: readonly AutomationTask[],
): IngestResult {
  const dir = scheduleInboxDir(configDir);
  if (!existsSync(dir)) return { added: [], rejected: 0 };

  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return { added: [], rejected: 0 };
  }

  const seen = new Set(existingTasks.map((t) => t.id));
  const added: AutomationTask[] = [];
  let rejected = 0;

  for (const name of names.slice(0, MAX_DRAFTS_PER_SCAN)) {
    const path = join(dir, name);
    let task: AutomationTask | null = null;
    try {
      task = sanitizeDraft(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // 半截/损坏的 JSON：留下文件供排查，但也别让它一直堆着（改名不友好，
      // 直接删——内容是 agent 生成的，重发成本很低）。
      task = null;
    }

    if (!task) {
      rejected++;
      try {
        unlinkSync(path);
      } catch {
        /* 已消失 */
      }
      continue;
    }

    // 同一个草稿重复投递：删文件、不重复添加。
    if (seen.has(task.id)) {
      try {
        unlinkSync(path);
      } catch {
        /* 已消失 */
      }
      continue;
    }

    seen.add(task.id);
    added.push(task);
    try {
      unlinkSync(path);
    } catch {
      /* 已消失 */
    }
  }

  if (added.length || rejected) {
    appendDiagLog(`schedule-inbox ingest added=${added.length} rejected=${rejected}`);
  }
  return { added, rejected };
}
