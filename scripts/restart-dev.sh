#!/usr/bin/env bash
#
# 重启 MPI 开发实例（dev）。
#
# 用途：手机端看不到桌面、需要让主机加载新构建的代码时用（例如改完 src/main 之后）。
# ⚠️ 改 src/ 之后必须重启才生效——electron-vite dev 的 watcher 在本机实测不总是重建
#    out/，最保险是「重建 + 重启」（本脚本两者都做）。
#
# 安全边界：只结束属于本仓库的 MPI Dev 实例——
#   * 主进程：命令行 == <repo>\node_modules\electron\dist\electron.exe .
#   * 子进程：命令行含 --user-data-dir=...\MPI Dev
#   其它 Electron 应用（user-data-dir 是 Roaming\Electron 等）与残留测试进程一律不碰。
#
# 用法：
#   bash scripts/restart-dev.sh            # 重建 + 重启
#   bash scripts/restart-dev.sh --dry-run  # 只报告将要操作哪些进程
#   bash scripts/restart-dev.sh --no-build # 跳过重建，只重启
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO/logs"
LOG="$LOG_DIR/dev-restart.log"
PIDFILE="$LOG_DIR/dev-run.pid"
DRY_RUN=0
DO_BUILD=1

# 先建日志目录：构建阶段就要往 $LOG 重定向，否则会出现"文件不存在"的误报
mkdir -p "$LOG_DIR"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-build) DO_BUILD=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

# ---- 进程枚举（Windows：wmic；Git Bash 下 bash 的 kill 对 Windows 进程不可靠，统一 taskkill） ----
dump_procs() {
  wmic process where "name='$1'" get ProcessId,CommandLine 2>/dev/null | sed -n '2,$p'
}
# 每行最后一个字段是 PID（CommandLine 里可能有空格）
pid_of() { awk '{print $NF}' <<<"$1" | tr -d '\r'; }
cmd_of() { sed 's/[[:space:]]*[0-9]*[[:space:]]*$//' <<<"$1"; }

MAIN_PATTERN='MPI.node_modules.electron.dist.electron.exe \.$'

collect_targets() {
  MAIN_PIDS=(); CHILD_PIDS=(); DEV_PIDS=()
  while IFS= read -r line; do
    [ -z "${line// }" ] && continue
    local cmd; cmd="$(cmd_of "$line")"
    if grep -Eq "$MAIN_PATTERN" <<<"$cmd"; then MAIN_PIDS+=("$(pid_of "$line")"); continue; fi
    if grep -q 'user-data-dir=.*MPI Dev' <<<"$cmd"; then CHILD_PIDS+=("$(pid_of "$line")"); fi
  done < <(dump_procs electron.exe)

  while IFS= read -r line; do
    [ -z "${line// }" ] && continue
    local cmd; cmd="$(cmd_of "$line")"
    if grep -q 'electron-vite' <<<"$cmd" && grep -Eq '(^| )dev( |$)' <<<"$cmd"; then DEV_PIDS+=("$(pid_of "$line")"); fi
  done < <(dump_procs node.exe)
}

collect_targets
echo "MPI Dev 主进程: ${MAIN_PIDS[*]:-<无>}"
echo "MPI Dev 子进程: ${CHILD_PIDS[*]:-<无>}"
echo "electron-vite dev: ${DEV_PIDS[*]:-<无>}"

if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] 到此为止（未结束任何进程、未重启）"
  exit 0
fi

# ---- 1) 先重建（放在杀进程之前：脚本被中断时最坏也只是"没重启"，而不是"关掉了") ----
if [ "$DO_BUILD" = 1 ]; then
  echo "重建中（electron-vite build）…"
  if ! npm --prefix "$REPO" run build >>"$LOG" 2>&1; then
    echo "❌ 构建失败——已中止，未动正在运行的实例（详见 $LOG）"
    exit 1
  fi
fi

# ---- 2) 结束旧实例 ----------------------------------------------------------
KILLED=0
for pid in "${MAIN_PIDS[@]:-}" "${CHILD_PIDS[@]:-}" "${DEV_PIDS[@]:-}"; do
  [ -z "$pid" ] && continue
  if taskkill //F //PID "$pid" >/dev/null 2>&1; then KILLED=$((KILLED + 1)); fi
done
echo "已结束 $KILLED 个进程"

# 等端口/句柄释放（旧 dev server 还占着 HMR 端口时新实例会起不来）
for _ in $(seq 1 10); do
  collect_targets
  [ "${#MAIN_PIDS[@]}" = 0 ] && [ "${#DEV_PIDS[@]}" = 0 ] && break
  sleep 1
done

# ---- 3) 启动 dev -----------------------------------------------------------
mkdir -p "$LOG_DIR"
{
  echo "==== $(date '+%F %T') restart-dev ===="
} >>"$LOG"
# detached 启动（见 dev-launch.mjs 注释：普通后台进程会被调用方的进程组回收）
if ! node "$REPO/scripts/dev-launch.mjs"; then
  echo "❌ 启动失败——看 $LOG_DIR/dev-run.log"
  exit 1
fi

# ---- 4) 等就绪（新实例） -------------------------------------------------------------
ready=0
for _ in $(seq 1 30); do
  sleep 3
  collect_targets
  if [ "${#MAIN_PIDS[@]}" != 0 ] && [ "${#DEV_PIDS[@]}" != 0 ]; then ready=1; break; fi
done

if [ "$ready" != 1 ]; then
  echo "❌ 60s 内没等到 electron 主进程/dev server，看日志末尾："
  tail -20 "$LOG"
  exit 1
fi

# ---- 5) 校验：新代码确实进了构建产物 ----------------------------------------
BUILT="$REPO/out/main/index.js"
STAMP="$(date -r "$BUILT" '+%F %T' 2>/dev/null || echo '?')"
echo "✅ 已重启：主进程 ${MAIN_PIDS[*]}，dev server ${DEV_PIDS[*]}"
echo "   out/main/index.js 构建时间 $STAMP"
for pat in context_usage thread.compact warmThread toolArgsSummary; do
  printf "   %-16s %s\n" "$pat" "$(grep -c "$pat" "$BUILT" 2>/dev/null || echo 0)"
done
if grep -q 'slice(-80)' "$BUILT" 2>/dev/null; then
  echo "   ⚠️ 构建产物里仍有 slice(-80)：可能是旧包缓存"
fi
