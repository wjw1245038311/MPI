#!/usr/bin/env bash
#
# 开通/关闭「附件直连」的 tailnet 暴露（P1）。
#
# 背景：附件直连服务由 MPI 自己起，但**只绑 127.0.0.1**（不暴露局域网/公网），
# 由 Tailscale 把它转发到 tailnet 上——和本机已有的 10808 转发同一套路数。
#
# 为什么走 **HTTPS** 而不是 TCP 转发：
#   PWA 是从 https://<ecs>:9443 加载的页面；若附件 URL 是 http://，浏览器会按
#   **混合内容**直接拦掉（媒体属于可拦类型），网页端就永远拉不到字节。
#   Tailscale 会给本机签发真实的 Let's Encrypt 证书（*.ts.net），三端都信这个证书。
#
# 用法（在**工作站**上执行）：
#   bash scripts/setup-attachment-serve.sh            # 开通（幂等）
#   bash scripts/setup-attachment-serve.sh --status   # 只看当前配置
#   bash scripts/setup-attachment-serve.sh --off      # 关闭
#
# 端口：内部监听 127.0.0.1:8899（MPI 侧由 MPI_ATTACHMENT_PORT 改），
#       tailnet 侧 https 8443（MPI 侧由 MPI_ATTACHMENT_PUBLIC_PORT 改，两处要保持一致）。
set -uo pipefail

INTERNAL_PORT="${MPI_ATTACHMENT_PORT:-8899}"
PUBLIC_PORT="${MPI_ATTACHMENT_PUBLIC_PORT:-8443}"

# Windows 上 Tailscale CLI 默认不在 PATH（见 config.json 的 tailscaleBin）。
TS="${MPI_TAILSCALE_BIN:-tailscale}"
if ! command -v "$TS" >/dev/null 2>&1 && [ -n "${MPI_TAILSCALE_BIN:-}" ]; then
  : # 绝对路径直接用
elif ! command -v "$TS" >/dev/null 2>&1; then
  echo "找不到 tailscale CLI：把它加进 PATH，或设置 MPI_TAILSCALE_BIN 到 tailscale.exe 的绝对路径" >&2
  exit 1
fi

case "${1:-}" in
  --status)
    "$TS" serve status
    exit 0
    ;;
  --off)
    "$TS" serve --https="$PUBLIC_PORT" off && echo "已关闭 https:$PUBLIC_PORT 的转发"
    "$TS" serve --tcp="$INTERNAL_PORT" off >/dev/null 2>&1 || true
    "$TS" serve status
    exit 0
    ;;
esac

echo "把 tailnet 的 https:$PUBLIC_PORT 转发到本机 $INTERNAL_PORT …"
if ! "$TS" serve --bg --https="$PUBLIC_PORT" "http://127.0.0.1:$INTERNAL_PORT"; then
  echo "❌ 开通失败。常见原因：tailnet 未启用 HTTPS 证书（管理台 → DNS → HTTPS Certificates）" >&2
  exit 1
fi
echo
echo "当前配置："
"$TS" serve status
echo
echo "客户端将使用：https://$( "$TS" status --json 2>/dev/null | grep -o '"DNSName": "[^"]*"' | head -1 | sed 's/.*: "//; s/\."//' ):$PUBLIC_PORT/att/<token>"
