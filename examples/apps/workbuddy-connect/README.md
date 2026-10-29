# workbuddy-connect（MPI 应用商店扩展）

把本机已登录的 **WorkBuddy（腾讯 CodeBuddy Code 桌面版）** 模型接进 MPI，并每天自动签到领积分。

**v2 起不再需要 WorkBuddy CLI**：实测网关本身就是 OpenAI 兼容的 `/v2/chat/completions`，扩展只做鉴权透传代理，工具调用由 pi 执行。

## 前置

- Windows 上已安装 **WorkBuddy 桌面端**，并登录过一次。
- 本机可**直连** `www.workbuddy.cn`（公司代理/DNS 拦截会导致不可用）。
- 模型走 WorkBuddy 自己的登录态与额度。

## 安装

MPI → 应用商店 → **从 zip 安装** → 选择 `workbuddy-connect-2.0.0.zip` → 启用。

**修改服务代码后必须完全退出 MPI 再打开**（仅停用/启用无效，同一进程的模块缓存不会失效）。启用后新建会话或重启 MPI，模型选择器里才会出现 WorkBuddy 分组。

## 配置

| 字段 | 说明 |
| --- | --- |
| 接入的模型 | 逗号分隔的模型 id；留空 = 账号目录里的全部模型 |
| 每日自动签到 | 开 / 关 |
| 并发上限 | 同时打给上游的请求数（默认 4） |

模型 id、真实上下文/输出上限与积分倍率都会打在应用日志里（来自 `/v3/config`）。

## 实现结构

```
mpi-app.json            清单（服务入口 / 配置表单 / 能力声明）
service/index.cjs       activate/deactivate：读登录态 → 拉目录 → 起代理 → 写 provider → 签到
service/proxy.cjs       鉴权透传代理（流式原样转发；非流式在内部聚合）
service/wb-auth.cjs     WorkBuddy 5.6+ 加密凭据的解密（AES-256-GCM + 字段 AAD）
service/wb-checkin.cjs  签到状态 / 领取 / 每日幂等
```

```
pi（agent）
  │ OpenAI 兼容 POST /v1/chat/completions（tools / stream / usage）
  ▼
本机代理 127.0.0.1:8096
  │ 注入 Bearer + X-User-Id + X-Domain；强制 stream:true
  ▼
https://www.workbuddy.cn/v2/chat/completions
```

- 工具往返（`tools` / `tool_choice` / `tool_calls` / `role:"tool"` + `tool_call_id`）**原样透传**，pi 执行，代理不执行任何东西。
- 客户端要非流式时，代理内部用流式取上游、聚合成标准 `chat.completion`（content / tool_calls / finish_reason / usage）。
- 上游 401 时重读一次登录态再试；错误按 OpenAI 风格返回（401/429/502/504），日志用 `[local]` / `[upstream]` 区分。

## 已知限制

- 非官方接口：WorkBuddy 升级后路径/鉴权可能变化，届时应用会报错，不影响 MPI 其它功能。
- 消耗你账号的积分（模型日志里有倍率参考）。
- 只在本机可用；不把代理暴露到局域网。
- **图片请求曾全部失败（code 11135）**：根因不在本应用，而是 MPI 的 image-ref 扩展把回环地址上的 provider 都当成 Strata 视觉服务，把 `{type:"image"}` 换成了 `data:image/x-strata-path;base64,<本机路径>`，上游拿到的是一张“不是图片的图片”。两处已修：① MPI 主进程的扩展现在对回环地址也要先探测 `/vision/refs`（不是 Strata 就不插手）；② 本代理作为兜底，会在转发前把这类引用读回 `~/.cache/mpi-image-ref/` 里的真实文件。
- **上游图片识别偶发失败**：返回 `code 11135`「Please start a new conversation, replace the image, and try again.」时，代理自动重试 1 次，仍失败会给中文提示。极小（如 1×1）或损坏的图片会稳定触发。持续失败时，代理把这份失败请求的脱敏快照存到应用数据目录的 `last-image-reject.json`（图片只留 sha256/长度/头尾片段）。
