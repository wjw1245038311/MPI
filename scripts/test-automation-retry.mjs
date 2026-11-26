// 批次 C 的重试判定与并发信号量单测（独立成文件，避免与调度纯函数混在一起）。
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));
const { isRetriableFailure } = await import("../src/main/automation-retry-policy.ts");

let checks = 0;
const ok = (label) => {
  checks++;
  return label;
};

// ---- isRetriableFailure ---------------------------------------------------
// 只重试抖动失败；业务失败与超时重试只会重复浪费额度。
assert.equal(isRetriableFailure("Pi 返回错误：Connection error."), true, ok("网络抖动可重试"));
assert.equal(isRetriableFailure("fetch failed"), true, ok("fetch failed 可重试"));
assert.equal(isRetriableFailure("socket hang up"), true, ok("socket hang up 可重试"));
assert.equal(isRetriableFailure("Pi 进程在任务完成前退出（code=1）"), true, ok("进程退出可重试"));
assert.equal(isRetriableFailure("ECONNRESET"), true, ok("ECONNRESET 可重试"));
assert.equal(isRetriableFailure("getaddrinfo ENOTFOUND api.example.com"), true, ok("ENOTFOUND 可重试"));
assert.equal(isRetriableFailure("EAI_AGAIN"), true, ok("EAI_AGAIN 可重试"));

assert.equal(isRetriableFailure("Model not found: p/m"), false, ok("模型不存在不重试"));
assert.equal(isRetriableFailure("定时任务需要人工交互（select），无人值守运行已停止"), false, ok("需人工交互不重试"));
assert.equal(isRetriableFailure("运行超时（30 分钟），任务已停止"), false, ok("超时不重试"));
assert.equal(isRetriableFailure("任务被中止"), false, ok("被中止不重试"));
assert.equal(isRetriableFailure(""), false, ok("空消息不重试"));
assert.equal(isRetriableFailure(undefined), false, ok("非字符串入参不抛"));

console.log(`automation-retry ok (${checks} 项断言通过)`);
