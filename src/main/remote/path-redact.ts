/** 远程通道路径脱敏（事件通道 remoteSafeString 与错误响应 safeErrorMessage 共用）。
 *
 * 把本机文件系统路径替换成 [path]，避免向配对设备泄露主机目录结构。
 *
 * ⚠️ URL 不能误伤：`(?<![A-Za-z])` 排除 http(s):/ 这类 scheme——否则 `https://`
 * 里的 `s:/`（字母+冒号+斜杠）会命中盘符分支，整条 URL 被吃成 `http[path]`。
 * 2026-10-10 真机事故：PWA 用户消息含 https 链接 → 事件通道脱敏后与快照不一致，
 * 乐观回显按文本相等对账失败 → 同一条消息上屏两次（一次完整、一次 [path]）。
 */
const PATH_RE = /(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|var|tmp|workspace)\/)[^\s"'<>`]*/gi;

export function redactRemotePaths(value: string): string {
  return value.replace(PATH_RE, "[path]");
}
