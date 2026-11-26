/**
 * 定时任务失败的可重试判定（纯函数，无 IO、无第三方依赖）。
 *
 * 单独成文件的原因：automation.ts 的依赖链会拖进 pi 扩展运行时（typebox 等），
 * 在纯 node 测试里跑不起来；这段判定是纯字符串规则，抽出来就能直接断言。
 *
 * 判定原则：
 *   - 只重试「抖动类」失败：网络中断、进程意外退出；
 *   - 业务失败不重试：模型不存在（重试也不会出现）、需要人工交互（无人值守下
 *     永远等不到）；
 *   - 超时 / 被中止不重试：那是已经放弃了，再跑一次只会再超时一次。
 */

const NON_RETRIABLE = /超时|被中止|aborted|需要人工交互|Model not found|模型不存在/i;

const RETRIABLE = new RegExp(
  [
    "Connection error",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "socket hang up",
    "network",
    "fetch failed",
    "进程在任务完成前退出",
    "code=",
  ].join("|"),
  "i",
);

export function isRetriableFailure(message: unknown): boolean {
  const m = typeof message === "string" ? message : "";
  if (!m) return false;
  // 白名单优先：先排除不可重试，避免 "Model not found: Connection refused"
  // 这类混合文本被后半段误判成网络错误。
  if (NON_RETRIABLE.test(m)) return false;
  return RETRIABLE.test(m);
}
