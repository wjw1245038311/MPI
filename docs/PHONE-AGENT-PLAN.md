# 手机端自持 Agent（不依赖桌面端）设计

> 状态：**设计稿，未开工**。最后更新：2026-11-05。
> 本文只定边界与契约，不含代码改动。相关文档：`MOBILE-NATIVE-DESIGN.md`（原生端选型）、
> `MOBILE-NATIVE-HANDOFF.md`（现状交接）、`AGENTS.md`（发版铁律）。

## 0. 一句话

在现有「桌面远端的遥控器」之外，新增一条**手机自己跑 agent**的路径：两者进程隔离，
共享唯一一层「身体」（无障碍读屏 / 动作 / 悬浮条 / 安全闸），脑各自独立。

### 0.1 已定的决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 隔离档次 | **档 2：进程级 + 单一身体层** |
| 2 | 身体层是否对桌面开放 | **开放，但默认关闭**（设置项显式开启） |
| 3 | 先做什么 | 本文（隔离边界 + IPC 契约 + 更新方案） |

### 0.2 非目标

- 不做 iOS；不做 root 级特权通道（Shizuku 只在身体层预留接口，首版不实现）。
- 不让手机端跑完整的 MPI 主进程（MPI 有 `node-pty`、`@zvec/zvec`、`@napi-rs` 原生依赖，
  搬不上 Android；手机侧只能是「pi + 手机专用扩展集」）。
- 不改现有中继协议语义（只在需要时新增 `device.call` / `device.reply` 两种 envelope）。

---

## 1. 进程与模块边界

```
同一个 APK（同一个 applicationId / uid）
┌──────────────────────────────────────────────────────────────┐
│  :main（默认进程）        ← 现有遥控器，一行不改               │
│   MainActivity / AppViewModel / RelayClient / HostSession     │
│   MpiLinkService(dataSync) / Notifier / Updater               │
│         │                                                     │
│         │── 作为 client 连身体层（仅当「允许桌面驱动」= 开）   │
│         │                                                     │
│  :agent（新进程）          ← 本机脑                            │
│   AgentService(前台服务) + libnode + pi(rpc-entry) + 本机会话  │
│         │                                                     │
│         │── 作为 client 连身体层                               │
│         ▼                                                     │
│  :body（新进程）           ← 唯一的共享层                      │
│   MpiA11yService(无障碍) · 采集 · 动作 · 悬浮条 · 确认卡 ·     │
│   安全闸 · 应用名单 · 操作记录                                 │
└──────────────────────────────────────────────────────────────┘
        共享（只读）：APK 更新 · Keystore（不同别名）· 系统权限
```

### 1.1 模块划分（Gradle）

| 模块 | 内容 | 依赖规则 |
|---|---|---|
| `:app` | 现有远端栈 + UI 外壳 | 可依赖 `:bodyclient`，**不依赖** `:agent` |
| `:body` | 无障碍服务、采集、动作、悬浮条、确认卡、安全闸 | **不依赖任何脑** |
| `:bodyclient` | 身体层的客户端 SDK（帧编解码 + 连接管理，纯 Kotlin） | 只依赖 `:bodyproto` |
| `:bodyproto` | 帧格式与消息定义的唯一事实源（纯 Kotlin，无 Android 依赖） | 无 |
| `:agent` | 脑：libnode 宿主、pi 扩展集、本机会话 | 可依赖 `:bodyclient`，**禁止**依赖 `:app` |

> lint/CI 加一条反向依赖检查：`:agent`、`:body` 不得 import 中继包（`com.mpi.app.data.RelayClient`
> 等）。这条边是「隔离」能否维持的唯一硬保证。

### 1.2 共享矩阵

| 维度 | 结论 | 做法 |
|---|---|---|
| 网络/会话 | **完全隔离** | `:agent` 不建中继连接，只用模型 API 地址 |
| 存储 | **完全隔离** | `:agent` 用 `filesDir/agent/`；`:app` 现有目录不动 |
| 密钥 | 隔离（别名分开） | `SecretBox` 的 Keystore 别名带命名空间前缀 |
| 崩溃域/内存 | **隔离**（进程级） | `android:process=":body"` / `":agent"` |
| 依赖树 | **隔离**（编译期强制） | 模块依赖边 + lint 规则 |
| 前台服务 | 各自一条 | `:agent` 用 `specialUse`（见 §5.4 待核实项） |
| APK / 自更新 | **隔不掉** | 同一 APK、同一 `Updater`/`ApkPatch`/`FileProvider` |
| 系统权限 | **隔不掉**（uid 级） | 无障碍/悬浮窗/通知授权一次，两栈都拥有 |
| 唤醒锁 | 需协调 | 拆成两份租约（`:app` 一条、`:agent` 一条），互不覆盖 |

---

## 2. 身体层能力（对外的全部接口）

身体层只回答「这块屏上有什么、能不能点」，**不做任何策略判断以外的决策**：

| 能力 | 说明 |
|---|---|
| 采集 | AccessibilityNodeInfo 树 → 纯数据 `UiNode`（与 Android 类型解耦，便于 JVM 单测） |
| 屏文本 | 一节点一行 `[n] 角色 标签`，分区 顶部/中部/底部，可滚动容器缩进一级，3000 字符预算，`⚠` 标需确认、`+` 标新增 |
| 动作 | tap / long / type / scroll / key / tapXY；**三级退化**：节点动作 → 可点祖先（≤4 层且矩形含本节点中心）→ 手势注入 |
| 复验 | 动作前比对 `fingerprint = window|bounds|role|text|checked`，不符返回 `STALE_SCREEN` |
| 安全闸 | 确认三档 + 应用名单（不碰/每步确认/照常）+ 硬拒绝（自身 App、系统设置页、密码与验证码框）+ 敏感词 `⚠` + 卡号/身份证打码 + handoff |
| 悬浮条 | 胶囊 / 卡片 / 小球；暂停·继续·停止；确认卡在底部；`TYPE_ACCESSIBILITY_OVERLAY` + 无障碍连接的 `WindowContext` |
| 生命期 | 熄屏即停、3 分钟无动作自动结束、Stop 单一路径（悬浮条 / 通知 / 设置页三处收口到同一函数） |

**关键约定**：`screenId` 与元素 `[n]` 编号**只对本次快照有效**。任何动作都必须带 `screen` 字段，
身体层据此判断过期，客户端不得复用旧编号。

---

## 3. IPC 契约

### 3.1 传输与帧

- 传输：`LocalSocket`，抽象命名空间 `com.mpi.app.body`（不落文件系统，避免 sun_path 长度问题）。
  同 uid 才连得上；额外要求首帧带 token。
- token：`:body` 启动时生成 32 字节随机串，写 `filesDir/body/session.token`（`0600`），客户端读它。
- 帧：`u32 LE 长度 | UTF-8 JSON`（长度上限 8 MB）。
- 二进制帧（v2 预留，截图用）：`u8 type=0x02 | u32 长度 | payload`。
- 版本协商：客户端在 `session.open` 里带 `protocol`；身体层只接受 `>= 自己支持的最小版本`，
  不匹配就返回 `VERSION_MISMATCH`，由 UI 提示「App 需要更新」。

### 3.2 消息

三类：`req`（带 `id`）→ `res`（带 `id`，`ok` 或 `err`）；`evt`（无 `id`，单向）。

| 方法 | 方向 | 参数 | 返回 / 说明 |
|---|---|---|---|
| `session.open` | client→body | `clientId, kind(agent\|remote), token, protocol` | `{ok, caps[], a11y: bool}`；`kind=remote` 需「允许桌面驱动」为开 |
| `screen.capture` | client→body | `detail?, image?, background?` | `{screen, app, text, stats{poor,hidden}, unreadable}` |
| `act.tap` | client→body | `screen, id, long?` | `{via: node\|ancestor\|gesture, screen}` |
| `act.type` | client→body | `screen, id, text, submit?` | `{readback, screen}`；密码框直接 `DENIED_BY_POLICY` |
| `act.scroll` | client→body | `screen, id?, direction` | `{screen}` |
| `act.key` | client→body | `key(back\|home\|recents\|notifications), screen?` | `{screen}` |
| `act.tapXY` | client→body | `observation, x, y` | `{screen}`；**每次都要用户确认** |
| `task.begin` | client→body | `goal` | `{taskId}`；抢**写入锁**（同一时刻只有一个写入者） |
| `task.end` | client→body | `taskId, result` | `{ok}`；释放写入锁、关闭悬浮条 |
| `task.stop` | **body→client** | `reason(screen_off\|a11y_lost\|user_stop\|interrupt)` | 客户端**必须**立即中止本轮 |
| `progress` | **body→client** | `step, note` | 供脑侧 trace 与悬浮条文案 |
| `confirm.pending` | **body→client** | `kind, reason` | 可选：提示「需要你来操作」 |
| `ping` / `pong` | 双向 | — | 30 s 心跳，2 次未回应视为断开 |

### 3.3 错误码

| 码 | 含义 | 客户端应对 |
|---|---|---|
| `NOT_ENABLED` | 无障碍没开 / 服务未连 | 引导去开（UI 一键跳设置） |
| `NO_SCREEN` | 当前屏读不到（安全窗口/黑屏） | 提示用户，停止任务 |
| `STALE_SCREEN` | `screen` 过期或 fingerprint 不符 | 重新 `screen.capture` 后再决定 |
| `DENIED_BY_POLICY` | 安全闸拒绝（带 `reason`） | 不得绕过；改走 `handoff` |
| `USER_DECLINED` | 用户在确认卡上拒绝（或 30 s 超时） | 停止该操作，不重试 |
| `NEEDS_USER` | handoff 超时（上限 10 min） | 结束本轮，告知用户 |
| `BUSY` | 已有其他写入者持锁 | 等待或提示 |
| `TIMEOUT` | 身体层内部超时 | 重读屏幕 |

### 3.4 超时与并发

| 项 | 值 | 理由 |
|---|---|---|
| 动作请求 | 服务端 30 s（含确认卡），客户端 45 s | 确认卡 30 s 不选 = 拒绝 |
| 采集 | 15 s | 树太大时身体层内部截断并标 `poor` |
| handoff | 10 min | 上限，超时返回 `NEEDS_USER` |
| 写入锁 | 单写入者 | 两个脑同时点会互相踩；读屏不加锁 |

### 3.5 桌面驱动的路径（默认关）

桌面**连不上**身体层——它没有 socket。链路是：

```
桌面 pi 扩展 → 中继(E2E envelope: device.call) → :main
   → 检查「允许桌面驱动」= 开 → :main 作为 kind=remote 的 client → :body
   ← device.reply ← 结果原路返回
```

这样「默认关」只是一行 if：`:main` 不开开关就不转帧。桌面永远拿不到身体层的直连能力。

---

## 4. 脑（`:agent`）

| 项 | 选型 | 说明 |
|---|---|---|
| 运行时 | **libnode**（Node ≥ 22.19，pi 的 engines 要求） | 不用 proot；参考 `jackwener/DSH-Android`（Node 24 编成 `.so`，`:engine` 前台服务里跑） |
| 引擎 | pi 的 `./rpc-entry`（`dist/bundle/rpc-entry.js`） | 桌面 `pi-bridge.ts` 已是「起进程 + 行 JSON 双向管道」，协议层可复用 |
| 扩展集 | 手机专用、纯 JS（`mpi-phone` 扩展：13 个工具 → IPC 调用） | 不加载桌面扩展（避免 zvec/node-pty 依赖） |
| 会话存储 | `filesDir/agent/sessions/`（与桌面格式同源，便于将来迁移） | |
| 模型 | 云端 API（OpenAI 兼容），key 存 Keystore（独立别名） | 桌面 LM Studio 在手机-only 模式下不可达 |

**工具集固定 13 个**（`apps / open / intent / notify / clipboard / screen / collect / tap / type /
scroll / key / tap_xy / handoff`）：名称、描述、schema **不随权限状态变化**——它们进每轮请求，
改动会废掉 KV cache；不能执行时返回可操作的解释，而不是隐藏工具。

---

## 5. 更新方案（体积变大后的核心风险）

### 5.1 现状与三个具体瓶颈（已核实）

现状：`Updater.kt` + `ApkPatch.kt` + `scripts/make-apk-patch.mjs`，自研 `MPIPATCH1`
（rsync 4 KB 块匹配 + deflate），清单里 `patch: {from,file,size,sha256}`。

| 瓶颈 | 现状证据 | 到 110 MB 时的后果 |
|---|---|---|
| **单一基线** | `patchUsable()` 要求 `patch.from == 当前安装版本` | 用户跨一版就必须下全量 |
| **全内存合并** | `File(sourceDir).readBytes()` + `ApkPatch.apply()` 返回新 `ByteArray` | 峰值 ≈ 3× APK ≈ 300 MB，低内存机型会被杀 |
| **zip 压缩放大 patch** | 历史 `0.5.11→0.5.12` 增量包 **15 MB**（APK 32 MB） | 110 MB 时增量包可能 30–60 MB，失去意义 |

### 5.2 三层更新域拆分

| 更新域 | 体积（估） | 频率 | 通道 | 机制 |
|---|---|---|---|---|
| **壳 APK** | ~35 MB | 每次发版 | 中继 / Seafile / GitHub | 现有 `MPIPATCH1` + **多基线** |
| **引擎包**（libnode + pi bundle） | 70–90 MB | 仅 Node/pi 升级 | 中继（**不进 APK**） | 内容寻址**块级增量** + 双份回滚 |
| **扩展集**（纯 JS） | < 1 MB | 频繁 | 随引擎清单 | 全量 + ed25519 签名 |

**核心思路：把大块不变的体积移出 APK。** APK 保持 ~35 MB（现有更新链路原样可用），
引擎首次启用手机操控时才下载（WLAN + 可断点续传），之后只下变化块。

### 5.3 引擎包：块级增量（复用 CAS 思路）

- 包格式：`engine-<piVer>-<abi>.pack`（单文件，避免上千个小文件）+ `engine.json`
  （`{ version, abi, size, sha256, chunks: [{hash, off, len}] }`）。
- 分块算法：**FastCDC**（内容定义分块，平均 64 KB）。相比固定块，重编译/重打包后仍能
  大量重同步；典型「pi 小版本升级」预计只下载 < 10%。
- 客户端流程：比对本地 chunk 集合 → 对缺失块发 `Range: bytes=<off>-<off+len-1>` → 校验块
  sha256 → 拼装 → 整体 sha256 复核 → 原子替换。
- 服务端无需逻辑：中继是静态托管（nginx/`/var/www/mpi-mobile`），支持 Range 即可。
- 回滚：`engine/current` 指针 + `engine/prev` 保留上一份；启动做健康探测（引擎 `--version`
  能跑通才切换），失败自动回滚并上报。

### 5.4 壳 APK 的改造（即使不拆引擎也该做）

1. **多基线**：清单从 `patch` 改 `patches: [{from, file, size, sha256}]`，客户端挑匹配项；
   发布侧只保留最近 N=3 版基线（体积换覆盖率，代价是发布脚本要维护窗口）。
2. **流式合并**：COPY 用 `RandomAccessFile`/`FileChannel.transferTo` 直接写新文件，内存 O(1)；
   彻底消除 3× 峰值。这是**上线前必做项**，不是优化。
3. **可重现构建 + 大资产不压缩**：`jniLibs` 不压缩、`zipalign -p` 4096 对齐、assets 固定顺序与
   固定 mtime（`SOURCE_DATE_EPOCH`）。依据：现在 32 MB 的包能产出 15 MB 增量，说明 zip 压缩把
   字节流打乱了——对齐后同样的改动应该降到几 MB。
4. 下载侧加 Range 断点续传（当前 `fetchTo` 是整包重下）。

### 5.5 待核实项（会影响 §5.4 的排期）

- Android 15 起 `dataSync` 型前台服务有「6 小时/天」限制（**记忆中的规则，未在本机核实**）；
  `:agent` 长跑引擎需改用 `specialUse` 并写用途说明。先用真机小实验确认。
- libnode 交叉编译（arm64）的实际工作量：`DSH-Android` 的原生产物不在仓库里
  （`build.gradle.kts` 从 `toolchains/out/jniLibs` 读取），**构建脚本未找到**；
  `nodejs-mobile` 类现成产物版本偏旧，能否满足 `>= 22.19` **未验证**。
- nginx 的 Range 支持与中继限速/并发策略需实测（参考 `relay-upload.mjs` 的 12 路分片经验）。

---

## 6. 阶段与验收

| 阶段 | 交付 | 验收（真机） |
|---|---|---|
| **P1** 身体层骨架 | `:bodyproto` + `:body` + 采集 + 屏文本 + tap/type/scroll/key + fingerprint；调试面板显示当前屏文本 | 对微信 / 高德 / 系统设置三个 App 能正确读出元素并点中 |
| **P2** 安全闸 + 悬浮条 | 确认三档 / 应用名单 / 硬拒绝 / 打码 / 悬浮条三态 / 熄屏即停 / 操作记录 | 密码框点不动；银行类 App 拒读；熄屏后任务立即结束 |
| **P3** 桌面驱动（默认关） | `:main` 作 `kind=remote` 客户端 + 中继 `device.call/reply` + 桌面扩展注册工具 | 桌面 pi 能读手机屏幕并完成一次点击；关掉开关后不可用 |
| **P4** 本机脑 | `:agent` + libnode + pi `rpc-entry` + 13 工具扩展 + 本机会话 UI | **桌面关机**状态下，说「打开微信给张三发一句我在路上」能跑完 |
| **P5** 更新改造 | 多基线 + 流式合并 + 引擎包下载与回滚 | 从上一版增量升级成功；断网重连续传；引擎包损坏能回滚 |

> P1–P3 不依赖 libnode，风险最低、可先行；P4 的排期取决于 §5.5 的构建链验证结果。

---

## 7. 风险

| 风险 | 性质 | 处置 |
|---|---|---|
| 品牌系统杀无障碍（荣耀/小米） | 真实且高频 | 首版不做自动恢复（需 Shizuku/ADB），改为「检测到关闭 → 提示 + 一键跳设置」 |
| 屏幕文字进模型 = 隐私外泄 | 真实 | 打码 + 硬拒绝 + 应用名单，与 P1 同批，不是可选项 |
| 多进程 IPC 调试成本 | 确定 | `:body` 调试面板 + logcat 按进程过滤的脚本 |
| 引擎包下载失败导致功能不可用 | 中 | 保留旧引擎 + 明确文案 + 一键重试；不阻塞遥控器 |
| APK 体积焦虑 | 中 | 壳保持 35 MB；若你最终判定 35 MB 仍不可接受，则回退到「Kotlin 精简脑」路线（APK 几乎不涨，但两套脑各维护） |

---

## 8. 附：参考项目取舍

| 参考 | 借鉴 | 不借鉴 |
|---|---|---|
| `ccch1mneyyy/dsh-Go` | 工具集固定、屏幕号 + 短命编号 + fingerprint、三级动作退化、安全闸分层、熄屏即停 | proot + Ubuntu rootfs（APK 183.8 MB） |
| `jackwener/DSH-Android` | libnode 嵌入、`:main`/`:engine` 双进程、能力桥私有通道、引擎不 fork | 直接复用其 toolchains（产物不在仓库） |
| `mobile-next/mobile-mcp` / `droidrun` | 「手」与「脑」分离的接口形状 | 依赖 ADB（手机自持场景不可用） |
| `Open-AutoGLM` | handoff / take_over 语义 | 纯视觉 + 坐标动作为主（成本与延迟不适合本场景） |
