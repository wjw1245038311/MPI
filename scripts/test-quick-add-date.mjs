import assert from "node:assert/strict";
import { parseQuickAdd } from "../src/renderer/src/lib/quick-add-date.ts";

// Fixed reference: Thu 2026-09-10 (local). tomorrow=09-11, friday=09-11, next monday=09-14.
const now = new Date(2026, 8, 10, 8, 0, 0);

// --- date phrases (regression) -------------------------------------------------
assert.deepEqual(parseQuickAdd("明天提交报告", now), { title: "提交报告", dueDate: "2026-09-11", dueTime: null });
assert.deepEqual(parseQuickAdd("周五前发布", now), { title: "发布", dueDate: "2026-09-11", dueTime: null });
assert.deepEqual(parseQuickAdd("下周一评审", now), { title: "评审", dueDate: "2026-09-14", dueTime: null });
assert.deepEqual(parseQuickAdd("9月30日上线", now), { title: "上线", dueDate: "2026-09-30", dueTime: null });
assert.deepEqual(parseQuickAdd("deploy on friday", now), { title: "deploy", dueDate: "2026-09-11", dueTime: null });
assert.deepEqual(parseQuickAdd("写周报", now), { title: "写周报", dueDate: null, dueTime: null });

// --- time phrases (new) ---------------------------------------------------------
// Bare time => today.
assert.deepEqual(parseQuickAdd("14:30交报告", now), { title: "交报告", dueDate: "2026-09-10", dueTime: "14:30" });
assert.deepEqual(parseQuickAdd("晚上8点前交作业", now), { title: "交作业", dueDate: "2026-09-10", dueTime: "20:00" });
// Date + time combined (time runs on the remainder after date stripping).
assert.deepEqual(parseQuickAdd("明天9点开会", now), { title: "开会", dueDate: "2026-09-11", dueTime: "09:00" });
assert.deepEqual(parseQuickAdd("周五下午3点半评审", now), { title: "评审", dueDate: "2026-09-11", dueTime: "15:30" });
assert.deepEqual(parseQuickAdd("9月30日14:30上线", now), { title: "上线", dueDate: "2026-09-30", dueTime: "14:30" });
// Chinese minute forms.
assert.deepEqual(parseQuickAdd("下午3点一刻提醒", now), { title: "提醒", dueDate: "2026-09-10", dueTime: "15:15" });
assert.deepEqual(parseQuickAdd("上午10点45分检查", now), { title: "检查", dueDate: "2026-09-10", dueTime: "10:45" });
// English am/pm.
assert.deepEqual(parseQuickAdd("9am standup", now), { title: "standup", dueDate: "2026-09-10", dueTime: "09:00" });
assert.deepEqual(parseQuickAdd("3pm deploy", now), { title: "deploy", dueDate: "2026-09-10", dueTime: "15:00" });
assert.deepEqual(parseQuickAdd("12am reset", now), { title: "reset", dueDate: "2026-09-10", dueTime: "00:00" });
assert.deepEqual(parseQuickAdd("12pm lunch", now), { title: "lunch", dueDate: "2026-09-10", dueTime: "12:00" });

// --- invalid times fall through (no date, no time) -------------------------------
assert.deepEqual(parseQuickAdd("25:99开会", now), { title: "25:99开会", dueDate: null, dueTime: null });
assert.deepEqual(parseQuickAdd("9点60分检查", now), { title: "9点60分检查", dueDate: null, dueTime: null });

// --- a weekday must not overwrite an explicit date --------------------------------
const both = parseQuickAdd("9月30日周五开会", now);
assert.equal(both.dueDate, "2026-09-30"); // date wins; 周五 stays in the title
assert.equal(both.title, "周五开会");

console.log("quick-add-date tests passed");
