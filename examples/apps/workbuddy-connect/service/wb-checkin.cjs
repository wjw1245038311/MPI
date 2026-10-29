"use strict";
/**
 * WorkBuddy 每日签到（领取积分）。
 *
 * 两个接口（国内版网关 `www.codebuddy.cn`）：
 *   状态：POST /v2/billing/meter/checkin-activity-status  body {}
 *   领取：POST /v2/billing/meter/daily-checkin            body {}
 * 两者都只要 `Authorization: Bearer <token>` + `X-User-Id` + `X-Domain`。
 *
 * 每天只尝试一次（成功或"今天已签到"都落盘），避免反复点；状态请求失败**不**落盘，
 * 下次启动会重试。这是一个非官方接口，上游一旦调整，这里只会报一条失败日志，不
 * 影响模型接入本身。
 */

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const REQUEST_TIMEOUT_MS = 20000;
const STATE_FILE = "checkin.json";

function billingBase(domain) {
  const d = String(domain || "").trim().toLowerCase();
  if (d === "workbuddy.ai" || d.endsWith(".workbuddy.ai")) return "https://www.workbuddy.ai";
  if (d === "codebuddy.ai" || d.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
  return "https://www.codebuddy.cn";
}

function headers(token, uid, domain) {
  const base = billingBase(domain);
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
    Origin: base,
    Referer: base + "/",
    ...(uid ? { "X-User-Id": uid } : {}),
    ...(domain ? { "X-Domain": domain } : {}),
  };
}

async function post(path, token, uid, domain) {
  const res = await fetch(billingBase(domain) + path, {
    method: "POST",
    headers: headers(token, uid, domain),
    body: "{}",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}：响应不是 JSON（${text.slice(0, 120)}）`);
  }
  if (!res.ok || json.code !== 0) {
    throw new Error(`HTTP ${res.status} code=${json.code} ${String(json.msg || "").slice(0, 160)}`);
  }
  return json.data && typeof json.data === "object" ? json.data : {};
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function statePath(dataDir) {
  return join(dataDir, STATE_FILE);
}

function readState(dataDir) {
  try {
    return JSON.parse(readFileSync(statePath(dataDir), "utf8"));
  } catch {
    return {};
  }
}

function writeState(dataDir, state) {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(statePath(dataDir), JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    /* 状态落盘失败不影响签到本身 */
  }
}

async function status(token, uid, domain) {
  const data = await post("/v2/billing/meter/checkin-activity-status", token, uid, domain);
  return {
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: Number(data.streak_days) || 0,
    dailyCredit: Number(data.daily_credit) || 0,
    todayCredit: Number(data.today_credit) || 0,
  };
}

async function claim(token, uid, domain) {
  const data = await post("/v2/billing/meter/daily-checkin", token, uid, domain);
  return {
    credit: Number(data.credit) || 0,
    streakDays: Number(data.streak_days) || 0,
  };
}

/**
 * 每天执行一次：今天没签就领，签过就记"already"。
 * @returns {{ status: 'claimed'|'already'|'inactive'|'skipped'|'failed', credit?: number, streakDays?: number, error?: string }}
 */
async function runDaily({ token, uid, domain, dataDir, log = () => {} }) {
  const day = today();
  const prev = readState(dataDir);
  if (prev.date === day && (prev.status === "claimed" || prev.status === "already" || prev.status === "inactive")) {
    log(`今天已处理过签到（${prev.status}），跳过`);
    return { status: "skipped", credit: prev.credit, streakDays: prev.streakDays };
  }
  try {
    const s = await status(token, uid, domain);
    if (!s.active) {
      writeState(dataDir, { date: day, status: "inactive" });
      log("签到活动当前未开放");
      return { status: "inactive" };
    }
    if (s.todayCheckedIn) {
      writeState(dataDir, { date: day, status: "already", streakDays: s.streakDays });
      log(`今天已签到（连续 ${s.streakDays} 天）`);
      return { status: "already", streakDays: s.streakDays };
    }
    const c = await claim(token, uid, domain);
    writeState(dataDir, { date: day, status: "claimed", credit: c.credit, streakDays: c.streakDays });
    log(`签到成功：+${c.credit} 积分（连续 ${c.streakDays} 天）`);
    return { status: "claimed", credit: c.credit, streakDays: c.streakDays };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`签到失败：${error}`);
    return { status: "failed", error };
  }
}

module.exports = { status, claim, runDaily };
