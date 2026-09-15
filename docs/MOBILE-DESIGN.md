# MPI 手机版 —「云中继」设计（v2）

> 状态：待实现。协议复用 `src/main/remote/protocol.ts`（传输无关 envelope），配对身份复用
> `src/main/remote/identity.ts`。v1 方案（P2P WebRTC 客户端）已废弃，理由见 §2。
> 参考实现分析：Qoder Mobile（§1.2）、flowflic/Pi-Studio-Remote（§1.1）。

## 0. 定位与目标

手机版 MPI 的两个核心用途：

1. **监视 Windows 端进度**——实时查看任意会话的运行状态、工具调用流、产物。
2. **与绑定的 Windows 端同步对话**——prompt/steer/followUp/abort，并在手机上批准权限弹窗（`ui.respond`）。

MVP 范围：配对 → 主机/会话列表 → 会话流式视图 → 发送控制 + 审批卡片（多档授权渲染 + diff 预览，§4.5/§6.4）→ WebPush 审批通知。
明确不做（v1）：文件编辑、完整设置页、云沙箱任务、Plan 结构化审核卡、iOS Live Activities、原生壳。

## 1. 历史沿革与参考分析

### 1.1 Pi Studio 时代（P2P 路线，资产仍在仓库内）

- **桌面端远程基础设施**自 v0.3.2 起完整存在：`src/main/remote/{protocol,identity,host,service}.ts`、
  `src/renderer/src/remote/transport.ts`（WebRTC DataChannel + 分块 + 心跳）、`RemotePanel.tsx`。
  protocol v1 envelope 覆盖 projects/threads 浏览、thread.subscribe/resync（seq 事件流）、
  prompt/steer/followUp/abort、**ui.respond**、file.tree/preview；claimWrite 30s 写租约防多设备互踩。
- **原作者的 Android 客户端**：`flowflic/Pi-Studio-Remote`（Kotlin + Jetpack Compose，v0.2.1，MIT）。
  功能齐全（Keystore Ed25519、WebRTC P2P、seq 恢复、审批对话框、Excel/CSV 预览），与 MPI 仅差两处品牌常量
  （`pi-studio://pair` → `mpi://pair`；签名前缀 `pi-studio-remote-v1|` → `mpi-remote-v1|`）。
  本项目不以其为基座（§6.3），但其协议/UX 代码是现成参考。
- v0.5.1 起桌面端 RemotePanel 入口被隐藏（待办 P1-10，Sidebar props 保留）；手册 §18 按"设计能力说明"标注。

### 1.2 Qoder Mobile 参考分析（本方案的主要参照物）

产品形态：**React PWA 是本体**（`qoder.com/m`，manifest + service worker），Android/iOS/HarmonyOS
原生壳共用同一套 web 代码；官方提供 H5 作为"无法下载 App 时的一等公民"。

架构：**账号体系 + 云端中继，无 P2P**。桌面/CLI 维持到 Qoder Cloud 的常驻 uplink（"环境"概念带
`connection_status`），手机只连云端 API。拆其 H5 bundle（v0.0.54）得到的真实 API 面：

| 端点 | 作用 |
| --- | --- |
| `/api/v1/remote/sessions`（分页）、`/{id}/resources` | 会话浏览、附加文件 |
| `/api/v1/remote/environments`（带 `connection_status`） | 本地电脑/云沙箱作为一等公民，首页显示在线状态 |
| `/api/v1/remote/system-events/stream` | **单条多路复用实时事件流**（非每线程一条订阅） |
| `/api/v1/remote/files` + `/files/config` | 文件上传到远程会话 |
| `/api/v1/mobile/devices`、`.../legacy-devices` | 设备绑定管理 |
| `/api/v1/remote/web-push/vapid-public-key` | **Web Push (VAPID)** → service worker 收推送 |
| `/api/v2/service/ws/asr` | WebSocket 语音输入（ASR） |

杀手功能：Agent 需要审批时推通知，**iOS Live Activities / Dynamic Island 锁屏直接响应**；Android 对应带按钮富通知。

本地端两种模式：

- **Attach**：运行中会话内 `/remote-control` → QR/URL（30s 刷新）→ 手机接管该会话。
- **Daemon**：`qoder remote-control` 后台守护进程，**不开桌面即可从手机发起新任务**，多任务并行、各自独立状态。

## 2. 为什么从 P2P WebRTC 换到云中继

| | P2P WebRTC（v1 方案） | 云中继（本方案） |
| --- | --- | --- |
| NAT/可达性 | 无 TURN，跨网段可能连不上；relay 候选被强制拒绝 | 两端只需出站 WSS，任何网络永远可达 |
| 锁屏推送 | 做不到（socket 随 App 挂起即断） | WebPush/FCM/APNs + deep link |
| 手机端复杂度 | WebRTC + SCTP 分块重组 + ICE 诊断（~400 行） | 裸 WebSocket |
| 隐私 | 内容不过任何服务器 | 过中继 → **自建中继 + E2E 加密**补齐（§4.3） |

关键洞察：**protocol v1 envelope 是传输无关的**。现在走 WebRTC DataChannel，换成 WSS 文本帧格式不变。
"换路线" = Windows 端加一条 relay uplink、手机端写 WebSocket 客户端；协议层与 RemoteService 零改动。
现有 P2P 代码保留在仓库（v1 不暴露入口，见 §10）。

## 3. 目标架构

```
手机 (React PWA, 可安装到主屏; iPad / Android 通吃)
   │ WSS ── E2E 加密帧 {e:1,n,c}（中继只见密文）
┌──▼──────────────────────────────┐    ┌────────────────────────────────┐
│ Relay 服务（新建，~500 行 Node）  │◄───►│ Windows MPI host                │
│ · 设备/主机注册与在线状态          │ WSS │ RemoteHost + relay-uplink.ts     │
│ · 不透明帧路由 deviceId↔hostId    │    │ （托盘驻留 = Qoder daemon 等价物） │
│ · push.request → WebPush(VAPID)  │    └────────────────────────────────┘
└─────────────────────────────────┘
   ▲ WebPush：审批/完成通知 + deep link（点开直达该线程）
```

组件职责：

1. **Relay**：无业务逻辑的转发器。维护 `deviceId → hostId` 路由表与在线状态；帧不解析、不解密、不落盘。
2. **Windows 端**：新增 relay uplink transport（§5），复用 RemoteService/identity；托盘驻留 + remote 常开即 daemon 模式。
3. **手机 PWA**：配对身份（Ed25519+X25519）、E2E 加解密、UI（§6）。

## 4. 协议与安全设计

### 4.1 传输帧格式

- WSS 文本帧 = JSON。应用数据帧为 protocol v1 envelope（`makeEnvelope`/`parseEnvelope` 原样复用），
  外层包一层加密信封：`{"e":1,"n":"<nonce b64>","c":"<ct||tag b64>"}`。中继只转发该对象，不解析内部。
- 保留 `PAYLOAD_TOO_LARGE`（2MB）上限；WSS 无 SCTP 16KB 限制，**不需要分块重组**。
- 明文控制帧（配对/注册/push 元数据，§4.2/§4.3）与加密数据帧在同一 socket 上按 `type` 区分。

### 4.2 配对与 E2E 密钥派生

沿用现有 QR ticket + Ed25519 挑战-签名流程（`host.ts handleHello`），两处扩展：

1. **身份加一把 X25519**：设备端在 `pair.hello` 附带 `x25519Pub`；主机端在 `remote-identity.json`
   （schema v2，向后兼容）持久化自己的 X25519 密钥对，并在 `pair.accepted` 回带 `hostX25519Pub`。
2. **会话密钥**：双方计算 `shared = X25519(myPriv, theirPub)`，
   `key = HKDF-SHA256(ikm=shared, salt="", info="mpi-mobile-v1|"+hostId+"|"+deviceId)` → 32B AES-256-GCM。
   静态密钥对 + 确定性派生 ⇒ **重连无需重新协商**，密钥可随时本地复算。

配对流程（经 relay）：

```
桌面: uplink 连接 relay ──(Ed25519 挑战签名)──► 注册 host:<hostId>
桌面: createPairingTicket() → QR(mpi://pair?payload=...) + {ticket.register} 上报 relay
手机: 扫码/粘贴链接 → WSS 连 relay → {pair.request, ticket, devicePub(Ed25519), x25519Pub, name}
relay: 按 ticket 路由给对应 host uplink（ticket 5 分钟失效，一次性）
桌面: handleHello 验签 → RemotePanel「待批准设备」→ 用户允许
桌面: {pair.approved, deviceId, deviceToken(32B 随机)} 经 relay 注册到 relay；回 pair.accepted(+hostX25519Pub)
手机: 存 deviceToken + hostId（IndexedDB/Keystore）；此后以 {hello, deviceToken} 直连
```

撤销：桌面 `revokeDevice` → uplink 发 `{device.revoke}` → relay 删路由并踢掉该设备 socket。

### 4.3 Relay 协议与可见性边界

控制帧（明文，短字符串）：

| type | 方向 | payload |
| --- | --- | --- |
| `host.register` / `ticket.register` / `pair.approved` / `device.revoke` | host→relay | §4.2 流程字段 |
| `hello`(deviceToken) / `pair.request` | device→relay | 设备身份/票据 |
| `push.request` | host→relay | `{deviceId, kind:"approval"\|"task-done"\|"error", title, body, deepLink}`（**仅元数据，无会话内容**） |

中继可见性边界：

- **不可见**：所有应用帧（密文）、提示词/代码/文件内容。
- **可见**：hostId/deviceId、在线状态、push 元数据（title/body 由 host 生成，约定保持通用文案如「MPI 需要批准」）。

心跳：双端 uplink 20s ping/pong，60s 无响应判死并清路由。设备离线期间**不做事件缓冲**——
手机重连后走既有 `thread.resync`（seq 补齐）恢复状态，relay 保持无状态转发。

### 4.4 威胁模型备注

- relay 被攻破 ⇒ 得到密文帧 + 元数据；E2E 密钥由静态身份对派生，需同时偷到设备私钥与主机私钥才能解密。
- deviceToken 泄露 ⇒ 可冒充该设备连上 relay（仍拿不到 E2E 明文）；桌面可随时撤销。
- 已知取舍：push 元数据过 relay 明文（§4.3），文案粒度见 §10 开放问题 3。

### 4.5 审批卡 diff 扩展（v1 兼容）

Qoder 最有辨识度的交互是**批准前展示真实代码 diff**。MPI 权限门目前只发文本 heading
（`Permission required: title\nreason\ndetail`），为 ui.request payload 增加可选结构化字段：

```json
{ "method": "select", "title": "...", "options": ["仅允许本次", "...", "拒绝"],
  "diff": { "path": "src/foo.ts", "added": 28, "removed": 13,
            "hunks": "<unified diff 文本，总量 ≤50KB，超限截断并带省略标记>" } }
```

- **主机端**：`permission-gate-ext.ts` / `ipc.ts onExtUi` 拦截 write/edit 类审批请求且能取到新旧内容时计算 unified diff 附带；其他类型审批不带该字段。
- **协议兼容**：`RemoteUiRequest` 本就含 `[key: string]: unknown`，旧客户端忽略未知字段，**无需 bump 协议版本**。
- **PWA 端**：渲染文件名 + `+N -M` 统计 + 绿/红 diff 行（等宽字体、横向滚动）；无 diff 字段时降级为纯文本卡。

## 5. Windows 端改动

| 文件 | 改动 |
| --- | --- |
| `src/main/remote/relay-uplink.ts`（新） | WSS 客户端：host 注册、ticket 上报、帧转发进 `RemoteService.handle()`、push.request 出口、心跳/重连（指数退避，复用 signaling retry 参数风格） |
| `src/main/remote/host.ts` | 配对批准时生成 deviceToken 并经 uplink 注册；`revokeDevice` 同步 relay；身份 schema v2（+X25519） |
| `src/main/config.ts` + `RemotePanel.tsx` | `config.remote.relayUrl`（默认值待定，§10）、relay 开关与状态灯、恢复被隐藏的入口按钮（P1-10） |

daemon 模式 = MPI 托盘驻留 + remote uplink 常开（文档化即可，v1 不新增独立进程）。
现有 WebRTC transport 代码不动。

## 6. 手机端 PWA 设计

### 6.1 技术栈

Vite + React + TS（与 MPI renderer 同栈；protocol 类型经小型共享包或 vendored copy 复用）。
- 密码学：`@noble/curves`（Ed25519/X25519，纯 TS）+ WebCrypto AES-GCM。
  **风险**：WebCrypto 原生 Ed25519/X25519 支持较新且各浏览器不齐——统一走 noble 规避兼容矩阵。
- 身份/令牌存储：IndexedDB（PWA）；后续原生壳迁 Keystore/Keychain。
- service worker：push 接收 + offline shell。

### 6.2 界面与流程

1. **配对**：相机扫码 / 粘贴 `mpi://pair` 链接 → hello → 「等待桌面批准」态 → accepted（存 token）。
2. **首页**：主机卡片（在线/离线、lastSeen）→ 项目列表 → 会话列表
   （状态徽章 running/idle/error/disconnected、updatedAt、messageCount，对齐 `RemoteThreadSummary`）。
3. **会话视图**：消息流渲染 text/thinking/tool 块（含 running 态与 artifacts），实时事件订阅；
   socket 恢复后按 lastSeq `thread.resync`。输入条：prompt/steer/followUp + abort + sandbox/full 切换
   （写操作前 claimWrite，租约过期自动重取）。权限变更由 host 推 `permission_changed`
   `{kind:"permission_changed", data:{permission}}`（二值 sandbox|full）事件，头部徽标实时同步；
   kind 为开放字符串，旧客户端忽略未知 kind。
4. **审批卡片**：收到 ui.request（confirm/select/input）→ 全屏卡片 → `ui.respond`；
   select 类直接渲染 options 列表——主机端权限门已内置多档授权
   （仅本次/本会话精确/前缀/工具/始终允许跨会话/拒绝，见 `permission-gate-ext.ts requestApproval`），
   PWA 通用渲染即可，无需新协议；write/edit 类审批带 diff 字段时按 §4.5 渲染 diff 预览。
   锁屏场景由 WebPush deep link 直达该线程。

### 6.3 为什么是 PWA、为什么不 fork Pi-Studio-Remote

- Qoder 已验证「H5 一等公民 + 原生壳后置」路线；PWA 一套代码覆盖 iPad Pro（iOS）与 Magic5（Android）。
- Pi-Studio-Remote 是 Android-only 且绑定 WebRTC 传输栈——本方案主路径已换 WSS，fork 它等于继承要废弃的层。
  其 Kotlin 侧协议/UX 实现留作参考，不作基座。

### 6.4 Qoder 用户视角功能清单与差距对照

Qoder Mobile 已实现的用户功能（官方文档 + 截图 + H5 bundle 拆解，2026-09）：

| # | 功能 | 说明 |
| --- | --- | --- |
| 1 | 登录授权 | Google/GitHub/Email 同账号；桌面端「允许移动端控制」+「保持唤醒」两开关 |
| 2 | 任务列表一屏 | In Progress / Idle 分组、行内状态图标、按环境（机器·仓库）过滤、「+」新建任务 |
| 3 | 对话流 + 折叠摘要 | 工具活动折成 "Read 3 files >" 单行；实时流式 + 滚动到底按钮 |
| 4 | Question Answers 卡 | agent 开工前澄清问题，手机上逐条回答后才继续 |
| 5 | Plan 审核卡 | 完整方案文档 → Approve / Suggest to edit（执行前审方案） |
| 6 | **审批卡带 diff** | "Qoder wants to edit" + 真实 diff（+28 -13 绿行）→ Allow once / Always allow in this session / Deny |
| 7 | 运行中纠偏 | "Add any feedback" 输入条（steer） |
| 8 | 锁屏审批 | 推送 + iOS Live Activities/Dynamic Island，不解锁直接响应 |
| 9 | Web 同功能 | qoder.com/agents + H5 版（App 下不了用网页） |
| 10 | 文件上传 / 语音输入 | 传文件到远程会话；ASR 语音指令 |
| 11 | Coming soon | 手机审产物/diff；云沙箱任务（电脑关机可跑） |

与 MPI 的差距对照：

| Qoder 功能 | MPI 现状 | 动作 |
| --- | --- | --- |
| 多档授权（once/session/persistent） | **已实现**：`requestApproval` 六选项，「始终允许」写 `config.trustedTools` 跨会话生效 | 无协议改动；PWA 通用渲染 select options |
| 审批卡 diff 预览 | gate heading 仅文本，无结构化 diff | **MVP**：§4.5 payload 扩展 + PWA diff 渲染（唯一需要主机端额外改动的项） |
| Plan 审核卡 | 迭代模式 plan+DAG 是普通文本消息，无结构化审批入口 | v2：plan 特殊块 + Approve/Suggest 按钮 |
| Question Answers 聚合 | 每个问题是独立 ui.request(input) | PWA 把连续 pending input 聚合成「回答」sheet，纯前端 |
| 工具活动折叠 | protocol v1 tool 块有 running/result | PWA 将连续同类工具折成 "Read N files >" 计数行，纯前端 |
| 任务行机器·仓库 + 在线点 | `RemoteThreadSummary` 有 projectId/state；单主机 MVP 无 host 维度 | 多主机场景（v2）引入 environment 概念 |
| 锁屏审批 | WebPush deep link 直达线程渲染审批卡 | iOS Live Activities v1 不做；Android 富通知按钮随原生壳后置 |

### 6.5 原生壳（Android APK）

自用形态的安卓端 = **一个全屏 WebView 壳**（`android/`，包名 `com.mpi.remote`），载入这份 PWA 的
线上构建；配对/E2E/会话流全部沿用 H5，壳只提供全屏窗口与原生兜底 UI。**不做**后台常驻与
锁屏推送（WebView 无 PushManager，自用场景只需「打开就能看到」）。构建、联调、限制见
`docs/ANDROID-SHELL.md`。

## 7. 推送通知设计
- MVP：**WebPush (VAPID)**。PWA 首次配对后 `serviceWorker.register` + `pushManager.subscribe`，
  subscription 经加密通道上报 host（host 存本地 config）；relay 收到 `push.request` 即向对应 sub 发 push。
  通知点击 → deep link `/thread/<id>` 直达线程并触发 resync。
- 实现注意（S8 真机验收后补齐，别重犯）：
  - 载荷必须走 **RFC 8291 §4 + RFC 8188 §2**（`salt16‖rs4‖idlen1‖keyid65‖ct‖tag`，明文尾部
    `0x02` 作 padding delimiter，两段式 HKDF 且 stage-1 用 auth secret 作 salt、`WebPush: info`
    绑定双方公钥）；`Crypto-Key: p256ecdsa=<vapidPub>` + `Authorization: vapid t=<jwt>, k=<pub>`，
    否则 FCM 直接 403。**不要**用旧草案（`0x02‖nonce‖ct`、单段 HKDF），也不要只跟 web-push 互验
    VAPID JWT 就算过——载荷自测自解会漏掉不互通。守护线：`scripts/test-webpush.mjs` 里的
    RFC 8291 §5 官方向量。
  - 通知点击**不要**用 `WindowClient.navigate()` 做深链（实测不生效）：给已打开的 App 窗口
    `postMessage` 让 App 走 SPA 深链；没有窗口时才 `openWindow`（冷加载需先等 E2E 握手就绪）。
- 后续：Android 原生壳 + FCM（锁屏操作按钮）、iOS Live Activities（v1 不做）。

## 8. 部署与运维

- **Relay**：Node 单进程（~500 行，无外部依赖或仅 ws），托管位置待定（§10）；日志只记连接事件。
- **PWA**：静态文件，HTTPS 必须（service worker + WebCrypto subtle 前提）。可随 relay 同机 serve 或走 CDN。
- 监控：relay 暴露 `/healthz`（在线 host/device 计数）即可，v1 不做告警。

### 8.1 当前部署形态（测试阶段，走 Tailscale）

- relay 跑在 **aliyun-ecs**：systemd `mpi-relay` 绑 tailnet IP `100.67.5.31:9443`，TLS 用
  `tailscale cert aliyun-ecs.tail38d5a.ts.net`（LE，90 天，另有每月续期 cron），
  `RELAY_STATIC_DIR=/var/www/mpi-mobile` 同机托管 PWA。
- 入口：PWA `https://aliyun-ecs.tail38d5a.ts.net:9443/`，wss 同址 `/ws`。**仅 tailnet 可达**
  （公网未开）；手机需在 tailnet 内。
- ⚠️ **WebPush 出口是硬约束**：大陆机器连不上 `fcm.googleapis.com`（relay 日志表现为
  `push … error: fetch failed`），而 Chrome/Android 的 WebPush 只能走 FCM、没有替代后端。
  测试期做法：relay 用 Node ≥24 的 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` 指向工作站在
  tailnet 上暴露的 xray（`tailscale serve --bg --tcp 10808 tcp://127.0.0.1:10808`），
  即 ECS → tailnet → 工作站 xray → 境外 → FCM；relay 代码不需要为代理做任何改动。
  生产更稳的做法是把 relay（或至少推送发送方）直接放在能直连 FCM 的境外机器——但那样
  host↔relay 的长连接要过墙，需另行评估。
  验收线：触发一次审批后 relay 日志出现 `push approval → device-…: sent`。

## 9. MVP 范围与实施 DAG

每阶段执行时再拆 ≤15min 检查点；偏差只修下游步骤并说明。

```
S0 Relay 服务原型（node 脚本双端 echo 通 + /healthz）
   ↓
S1 Windows relay-uplink transport（host 注册/重连/帧转发进 RemoteService）
   ↓                                        S2 PWA 脚手架 + 协议类型共享包
   └──────────────┬─────────────────────────┘
                  ↓
        S3 配对流程（QR → hello → 批准 → E2E 密钥派生，双端向量测试）
                  ↓
        S4 首页（主机状态 + 项目/会话列表）
                  ↓
        S5 会话视图（流式订阅 + resync + 块渲染）
                  ↓
        S6 发送控制（prompt/steer/followUp/abort + claimWrite）+ 审批卡片（多档授权渲染 + diff 预览，ui.respond）
                  ↓
        S7 WebPush 通知（VAPID + deep link）
                  ↓
        S8 部署 + RemotePanel 入口恢复（P1-10）+ 手册 §18 重写
```

验收基线：Magic5 / iPad 扫码配对 workstation → 实时观看一个运行中任务的工具调用流 →
锁屏状态下收到审批推送，点开在手机上批准一次权限弹窗。

## 10. 开放问题（待拍板）

1. **Relay 托管位置**：aliyun-ecs（自有机器、tailnet 内已有、数据完全自控）vs Cloudflare Durable Objects
   （免运维、全球边缘；内容过 CF，有 E2E 兜底）。接口相同，可后换。
2. **P2P WebRTC 路径去留**：v1 建议弃用（代码保留不暴露入口），同网段直连的低延迟收益是否值得双传输复杂度，v2 再评。
3. **push 元数据粒度**：通用文案「MPI 需要批准」vs 带线程标题（信息量 vs 泄露面）。

## 11. 测试策略

- 单元：E2E 密钥派生固定向量、加密帧往返、relay 路由表/心跳判死、ticket 过期与一次性。
- 集成：node 假 host + 假 phone 对真实 relay 跑配对→订阅→prompt→ui.respond 全链路（`scripts/test-relay-*.mjs`，登记 tests/registry）。
- 手工：Magic5 / iPad 真机配对、锁屏推送点击直达、断网重连 resync。

## 12. 开工前准备方案（新会话入口）

> 给新的迭代模式会话：先读本节 + §0-§4（决策基线），再按 §9 DAG S0→S8 执行。以下决策已拍板，除非用户明确改口，不要重新讨论。

### 12.1 已定决策（不重议）

- 路线：自建云中继 + E2E 加密（§2/§3）；客户端 = React PWA（§6.1）；protocol v1 复用、不 bump 版本（§4.5）。
- 不 fork Pi-Studio-Remote；现有 P2P WebRTC 代码保留但不动、不暴露入口（v1 弃用，见 §10 问题 2）。
- 多档授权复用主机端既有六选项结构，移动端通用渲染（§6.4）；diff 预览进 MVP（§4.5）。

### 12.2 开工前必须与用户确认（新会话先问）

1. **Relay 托管位置**：aliyun-ecs vs Cloudflare Durable Objects（§10 问题 1）。选 aliyun-ecs 时另需落实：
   - 公网 IP 对手机网络可达；端口规划与 TLS 终结方式（Caddy/现有反代）。
   - **PWA 需要可信 HTTPS**（service worker + WebCrypto subtle 前提）——裸 IP/自签证书不行，必须有域名 + 受信任证书（Let's Encrypt 即可）。域名归属一并确认。
2. push 文案粒度（§10 问题 3）：建议先通用「MPI 需要批准」。

### 12.3 环境与仓库约定

- 仓库 `E:\MyWorkspace\Code\MPI`（本机 = workstation，双远端 github/origin；同步流程见记忆）。
- 分支：从 main 新建 `feat/mobile-relay`；提交风格沿用 conventional commits + 中文描述。
- Node ≥ 24.14（repo engines），relay 与 PWA 同版本开发。
- 代码布局：`mobile/relay/`（Node，仅 ws 依赖）、`mobile/pwa/`（Vite+React）；protocol 类型经 `mobile/shared/` 共享包或 vendored copy。
- 测试登记约定：`scripts/test-*.mjs` + `tests/registry/logic-*.json`（参照 v0.6.11 app-store 模式）。
- changelog：仅用户可见改动发版时加 Unreleased 条目；本项目内部设计文档不需要。

### 12.4 S0 首步拆解（relay 原型，每检查点 ≤15min）

1. `mobile/relay/` 脚手架 + package.json（唯一依赖 ws）+ host/device 注册与路由表——验收：node 脚本模拟两端连接，`/healthz` 返回在线计数。
2. 不透明帧转发 + 心跳 20s ping / 60s 判死——验收：假 host 发帧 → 假 phone 收到；杀一端 → 另一端 60s 内收到 offline 事件。
3. `ticket.register` / `pair.request` 路由骨架（先明文透传，加密在 S1/S3）——验收：pair.request 到达正确 host uplink。

### 12.5 边界与止损规则

- 每阶段开工前先列检查点清单；连续两次修正无进展或计划前提被证伪 → 立即停下上报，不硬撑。
- S1 之前不改 `src/main/remote/{protocol,identity,host,service}.ts`（S1 按 §5 只新增 relay-uplink.ts + host.ts/config.ts/RemotePanel.tsx 小改）。
- RemotePanel 入口恢复（P1-10）在 S8，不要提前动 Sidebar。
