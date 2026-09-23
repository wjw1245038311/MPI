# MPI 原生手机端 · 交接文档

> **本文自包含**：新会话读完即可开工，不需要前序上下文。
> 设计基线在 `docs/MOBILE-NATIVE-DESIGN.md`（选型、IA、视觉、阶段划分都在那里）。
> 最后更新：2026-09-23。

---

## 0. 一句话现状

Kotlin + Compose 的原生安卓端已能**配对 → 看会话列表 → 进会话 → 发消息 → 审批**；
M0/M1/M2 完成（M2-6 键盘跟手待真机确认）；**PWA 交互细节移植（批 1–5）全部落地**；
**M4 原生能力（附件 / 语音 / 扫码）、M5 通知 + 前台服务、M6 自更新均已实现**；
**本地缓存（A 方案：会话快照 + 首页列表秒开 / 离线可读）已实现，待真机验收**。
已随 **v0.9.0** 提交并推送（origin 自建 GitLab + github，含 tag）。

> 施工图：`docs/MOBILE-NATIVE-PORT-BACKLOG.md`（批 1–5 + M4–M6 全部完成）。
> **已真机验证**（2026-09-23）：多台桌面同时运行任务，手机端消息/审批**无串台、无漏收**——
> 因此不需要“多连接”架构改造（原计划里的 B 方案取消）。

---

## 1. 关键坐标

| 项 | 位置 |
| --- | --- |
| 设计基线（先读这个） | `docs/MOBILE-NATIVE-DESIGN.md` |
| PWA 交互细节移植清单 | `docs/MOBILE-NATIVE-PORT-BACKLOG.md` |
| 原生工程 | `mobile/app/`（包名 `com.mpi.app`） |
| 源码 | `mobile/app/app/src/main/java/com/mpi/app/`（52 个 .kt，约 11.4k 行） |
| 测试 | `mobile/app/app/src/test/java/com/mpi/app/`（192 项） |
| 联调脚本 | `scripts/mobile-dev-harness.mjs` |
| 图标生成器 | `scripts/gen-android-icon.mjs` |
| 加密向量生成器 | `scripts/gen-android-vectors.mjs` |
| 本地 APK | `mobile/app/publish/MPI-Android-Native-0.1.0.apk`（+ `.sha256`） |
| Seafile 分发 | `E:\Seafile\wei_jw2\我的资料库\Agent\MPI-Android-Native-0.1.0.apk`（哈希已核验） |
| 旧 WebView 壳（冻结） | `android/`，包名 `com.mpi.remote` |

> ⚠️ 别混淆：`android/` 是**旧壳**（冻结维护，只修 bug）；`mobile/app/` 是**新原生版**。两者可并存安装。

---

## 2. 常用命令

```bash
# 构建 APK
cd mobile/app && JAVA_HOME='<MyWorkspace>/Software/jdk21' ./gradlew assembleDebug

# 跑单测（112 项，约 1 分钟）
cd mobile/app && JAVA_HOME='<MyWorkspace>/Software/jdk21' ./gradlew :app:testDebugUnitTest

# 构建 + 测试一起（改动后推荐）
cd mobile/app && JAVA_HOME='<MyWorkspace>/Software/jdk21' ./gradlew assembleDebug :app:testDebugUnitTest

# 联调环境（本地 relay + 真 RemoteHost + 真 RelayUplink，打印配对链接）
node --experimental-transform-types scripts/mobile-dev-harness.mjs
HARNESS_SIMULATE=1 node --experimental-transform-types scripts/mobile-dev-harness.mjs   # 额外推模拟事件流
adb reverse tcp:9001 tcp:9001    # 模拟器连宿主 9001

# 重新生成图标 / 加密向量
node scripts/gen-android-icon.mjs
node --experimental-transform-types scripts/gen-android-vectors.mjs

# 改了桌面端 remote 代码后必须跑（项目规则）
npm test -- relay && npm run test:pwa-pairing
```

---

## 3. 已完成

### M0 工程与风险证伪（100%）

| 项 | 结果 |
| --- | --- |
| 环境 / 骨架 / 编译 | ✅ APK 18.1MB（含图标） |
| 加密内核 | ✅ base64url / HKDF / X25519 / AES-GCM / 设备身份 |
| **闸门①加密字节级一致** | ✅ 与 TS 参考实现**双向**互验（解得开 TS 密文 + 复现 TS 密文）；deviceId/PEM/签名全一致 |
| **闸门②真实中继互通** | ✅ 完整握手 + 错 token 被 4001 |
| **闸门③长列表性能** | ✅ 2000 条 5–6ms/帧、卡顿 0.07%（雷电模拟器） |
| gradle 国内可下 | ✅ 未加额外镜像即通过 |
| 包名可并存安装 | ✅ 模拟器桌面同时显示两个 MPI 图标 |

### M1 打通「配对 → 看到列表」（100%）

| # | 交付 |
| --- | --- |
| M1-1 | 配对信息持久化（Android Keystore 加密卷 + 文件原子写；损坏时抛错不静默清空） |
| M1-2 | `HostSession`：重认证 + E2E 收发 + 退避重连 + 失败分类（终止性 vs 可恢复） |
| M1-3 | `Requester`：requestId 配对、超时、错误映射 |
| M1-4 | 项目/会话数据层 + 运行中轮询（空闲与掉线即停） |
| M1-5a/b | 配对页 + 首页列表 + 视觉打磨 + 抽屉 + 返回键语义 |
| M1-6 | 端到端验收通过（模拟器） |

### M2 会话视图（4/6）

| # | 状态 | 交付 |
| --- | --- | --- |
| M2-1 | ✅ | `ThreadSession` 归约器：快照/事件/seq 缺口/乐观回显/增量节流 |
| M2-2 | ✅ | 会话视图 + 导航（思考折叠、工具行折叠、代码块、粗体） |
| M2-3 | ✅ | 输入条 + `ThreadActions`（写租约三种情况）+ 失败重试 |
| M2-4 | ✅ | 审批卡 + diff 预览 + 回答形状 |
| M2-5 | ✅ | 配置 chip 行（模型/模式/权限）+ 底部 Sheet + 上下文用量/压缩 |
| M2-6 | ⏳ | 键盘跟手**真机**验证 + 端到端验收 |

---

## 4. 未完成 / 下一步

### M2-5 配置 chip 行（✅ 已完成）

会话页标题下方一排 chip（权限 / 任务模式 / 模型 / 上下文用量），点击弹底部 Sheet。
落在 `ui/ThreadToolbar.kt`；写操作走 `AppViewModel.configAction`；用量口径的纯函数有单测。

### 本地缓存 A 方案（✅ 已实现，待真机验收）

解决的问题（用户 2026-09-23 反馈）：打开会话**每次都要等全量快照**（慢、断网打不开）、
应用重启后首页空白。协议侧 `thread.subscribe` / `thread.resync` **只返回全量快照**，
主机不存历史事件，所以真增量（方案 B）要三端同改——先做**只改客户端**的 A 方案。

| 交付 | 落点 |
| --- | --- |
| 会话快照缓存（按主机 + 会话落盘，原子写、条数/体积上限、损坏即删） | `data/ThreadCache.kt` |
| 首页列表缓存（projects + threads，重启断网也能看列表） | `data/HomeCache.kt` |
| 缓存公共工具（id→SHA-256 文件名、原子写） | `data/CacheFiles.kt` |
| 缓存预热：`prime()` 立刻渲染缓存，`onSnapshot` 在实时快照到达时写缓存 | `data/ThreadSession.kt` + `ThreadView.cachedAt` |
| 打开会话：先读缓存预热 → 再 `subscribe()` 替换；刷新成功即清 `cachedAt` | `ui/AppViewModel.openThread` |
| 首页：启动即读缓存，连接中/失败**不再用转圈挡住列表** | `data/HostRepository.kt` + `ui/HomeScreen.kt` |
| 离线提示：会话页「显示本地缓存（x 分钟前），正在获取最新内容…」；首页「离线 · 显示本地缓存」 | `ui/ThreadScreen.kt` / `ui/HomeScreen.kt` |
| 移除主机 / 重置本地数据时清缓存 | `AppViewModel.removeHost` / `resetLocalData` |

**行为要点**

- 缓存只是**加速手段，不是数据源**：读坏即删、写失败静默，绝不因缓存打扰用户。
- 断网/未连上时也能进会话看上次内容，但**必须显式标注**是缓存（§1.1 不静默失败）。
- 明文存 `filesDir/thread-cache/`、`filesDir/home-cache/`（应用私有，root 外读不到）；
  配对凭证仍走 Keystore 加密卷，两者不混。
- 刷新成功才算「最新」；刷新失败保留 `cachedAt`，离线提示继续显示。

**测试**：`ThreadCacheTest`（7 项）、`HomeCacheTest`（5 项）、`HostRepositoryTest` 缓存 2 项、
`ThreadSessionReducerTest` 缓存 3 项（prime / 清标记 / 只对实时快照回调）。

**模拟器烟测（雷电，2026-09-23，走 `mobile-dev-harness` 假主机）已过**

| 步骤 | 结果 |
| --- | --- |
| 配对后开会话 → 等快照 | `run-as` 可见 `files/home-cache/*.json` 与 `files/thread-cache/<hosthash>/*.json` 均已写入 |
| 停中继 → 杀进程重开 | 首页直接显示缓存列表，顶栏「离线 · 显示本地缓存（1 分钟前）」，不白屏 |
| 离线进会话 | 缓存消息立刻上屏，顶部「离线：显示本地缓存（1 分钟前），正在获取最新内容…」+ 错误横幅带「重新同步」 |

未覆盖：真机手感 / 真实桌面主机下的自更新与长会话体积（仍按 §7 清单真机复验）。

**未做**：真增量（方案 B，协议加 `sinceMessageId`）；缓存只随 subscribe/resync 更新，
用户读完流式内容又没重开时会落后一次同步（下次打开会刷新）。

### M2-6 真机验收（需要用户配合）

验收标准：真机完成一轮「看进度 + 发指令 + 批准」+ 键盘无卡顿。

**键盘跟手是硬要求**（设计文档 §7 避坑 #1：千问正是在这里被批评）。模拟器测不出手感。

### 待真机验证的证伪项（设计文档 §2.5）

| # | 项 | 状态 |
| --- | --- | --- |
| 4 | Compose 键盘避让在荣耀真机跟手 | ⏳ 待验（M2-6） |
| 5 | 前台服务在 MagicOS 可存活 | ⏳ 待验（M5） |
| 7 | 包名区分可并存安装 | ✅ **已在模拟器验证** |

---

## 5. 未结案问题（重要）

### 5.0 真机第 8 条：手机批准后桌面弹窗不消失 —— ✅ 已修，待真机复验

根因：手机 `ui.respond` 只走主进程 `bridge.respondExtUi`（pi 已继续），但桌面卡片渲染自
`store.extuiQueue`，那张队列只认本地点击与关闭会话。现已在主进程应答成功后广播
`pi:extuiResolved`，renderer 收到后收起对应卡片（渠道线程的自动取消走同一通道）。
⚠️ 改的是 main 进程，**验证需重启桌面端 MPI**（`Ctrl+R` 不够）。

### 5.1 host→device 帧是否真的会丢 —— **存疑，未结案**

联调 harness 推事件流时观察到「帧到不了设备」，但**未能证实是真缺陷**：

- 已用回归测试证明**归约器处理该序列正确**（`ThreadEventReplayTest`）；
- 我自己的测量时序足以解释现象（旧应用实例触发了模拟流 → 随即被 force-stop，
  帧发给了正在拆除的 socket）；harness 的一次性 `simulated` 标志又阻止了新实例重放。

**结论：需要接真实桌面端复核**（见 §7 清单第 6/7 步）。已顺带修掉两条相关真问题：

1. 中继重启后 4001 被立即判死 → 已改为 3 次重试（`HostSession.AUTH_RETRY_LIMIT`）；
2. `replaced`/`revoked` 不含 `from` 被当数据帧丢弃并刷警告（实测 59 条）→ 已纳入
   `CONTROL_TYPES`，并给警告补上帧类型。

### 5.2 临时/调试痕迹

- `BenchmarkScreen`（`--ez benchmark true` 进入）保留：它是 M0-7 的性能基准页，
  后续界面迭代仍可用。**不进正常启动路径。**
- `request_id` 级诊断未做（设计文档 §6 的「诊断页」尚未实现）。

---

## 6. 环境与踩坑速查（**先读这段，能省几小时**）

### 6.1 本会话踩过、且只有真机能发现的坑

| 坑 | 现象 | 处置 |
| --- | --- | --- |
| **Android Keystore 不允许自带 IV** | `Caller-provided IV not permitted`；本地存储完全不可用 | 加密时**不传 IV**，由系统生成后读 `cipher.iv`；解密仍传 IV。见 `SecretBox.SealedFormat` |
| **Android 9+ 默认禁明文流量** | 联调直接连不上（`CLEARTEXT communication not permitted`） | `src/debug/res/xml/network_security_config.xml` **只在 debug** 放开；release 保持禁止 |
| 蓝牙/图标：包名与旧壳并存 | — | 已天然支持，无需处理 |

**教训**：这三类问题单测全绿也发现不了。**每步都上模拟器烟测**这条规矩不要省。

### 6.2 Kotlin / Compose 踩坑

| 坑 | 说明 |
| --- | --- |
| `kotlinx.serialization` 的 `encodeDefaults=false` **会静默省略带默认值的字段** | 协议版本字段（`v`/`e`）必须声明为**必填无默认值**，否则生成方永远发不出去 |
| `buildJsonObject { put(...) }` 需**显式 import** `kotlinx.serialization.json.put` / `add` | 否则报「String 不能赋给 JsonElement」 |
| Compose 里「不含 X 就提前 return」会**整段绕过后续样式分支** | 曾让粗体静默失效；样式切分逻辑要抽成**纯函数**并单测 |
| `async` 体内的异常会**取消父作用域** | 测试里断言失败必须用 `runCatching` 把结果包成值 |
| 测试方法最后一句是表达式 → 返回类型非 `void` | JUnit 会拒载整个测试类 |

### 6.3 构建 / 工具

| 事项 | 做法 |
| --- | --- |
| JDK / SDK / Gradle | `Software/jdk21`、`Software/android-sdk`、`mobile/app/gradle/wrapper`（8.10.2，走华为镜像） |
| `local.properties` 的 `sdk.dir` | **必须正斜杠**（反斜杠被 properties 当转义） |
| AAPT2 报 `Unexpected error during link`（错误输出为空） | Gradle transform 缓存陈旧 → 清 `~/.gradle/caches/<ver>/transforms/<hash>-<uuid>` 后重跑。**与管道无关**（已实测证伪） |
| 模拟器（雷电） | `F:/leidian/LDPlayer14/ldconsole.exe launch/quit --index 0`；**它抢占 0.0.0.0:2222 = GitLab SSH 端口，用完必须 quit** |
| uiautomator 取坐标 | 路径要加 `MSYS_NO_PATHCONV=1`，否则 `/sdcard/x.xml` 被 Git Bash 改写 |
| 真机坐标不要猜 | 用 `adb shell uiautomator dump` 取 bounds；**版面一改旧坐标就失效**（本会话踩过两次） |
| `python` | 本机是 Store 假入口，**会挂住**——用 `node` |

### 6.4 联调 harness 的使用陷阱（**血泪**）

顺序**必须**是：

```
1) adb shell am force-stop com.mpi.app     ← 先停应用
2) 启动 / 重启 harness                      ← 再起中继
3) 启动应用、点进会话                        ← 最后起应用
```

原因：harness 的模拟事件流是**一次性**的，会被「任何一次 subscribe/resync」触发。
若旧应用实例还开着线程，它重连时就会抢先触发模拟流，而随后 force-stop 会让帧发给
正在拆除的 socket —— 表现为「帧全部丢失」的假象。

另：**不要同时跑多个 harness 实例**——它们用同一个 hostId，会在中继上互相顶替，
表现为「服务端行为时好时坏」（本会话踩过，找了一轮）。

---

## 7. 真机验证清单（交给用户）

| # | 步骤 | 期望 |
| --- | --- | --- |
| 1 | 电脑起 MPI → 设置 →「手机远程控制」→ 启用中继（真实 `wss://`） | 面板显示在线 |
| 2 | 「配对手机」→ 复制链接 | 得到 `mpi://pair?payload=…` |
| 3 | 手机装 `MPI-Android-Native-0.1.0.apk` → 粘贴链接 → 开始配对 | 「等待桌面端批准」→ 批准后进首页 |
| 4 | 首页 | 项目与会话列表与电脑一致 |
| 5 | 点进会话 | 消息、工具行、代码块正常 |
| 6 | 发一句话 | 右侧气泡立刻出现，随后出现回复（**验证 host→device 是否真丢帧**） |
| 7 | 让 agent 改文件（触发审批） | **审批卡出现在输入条上方，带 diff** |
| 8 | 点「允许」 | 电脑弹窗消失、agent 继续（✅ 已修，见 §5.0；待复验） |
| 9 | 退出会话再进（或杀进程重开） | **先立刻显示上次内容**（顶部短暂出现「显示本地缓存」，随后自动消失） |
| 10 | 开飞行模式后杀进程重开 App | 首页仍有上次的会话列表，顶栏标「离线 · 显示本地缓存」；**不白屏** |

第 6、7 步是重点。第 9、10 步验本地缓存（A 方案）。回报时请附：哪步不符预期 + 界面上是否有红色横幅文字（关键线索）。

---

## 8. 协作约定（本项目）

- 提交信息用**中文** + conventional commits；**commit 后不自动 push**，等确认。
- 改 `src/main/remote/**`（共享/主进程）后必须跑 `npm test -- relay` 等**相关**套件。
- 手机端新增样式只用桌面端**同名令牌**（`--bg/--surface/--border/--text/-dim/-faint/--accent/…`）。
- 不引 UI 库 / 图标库；图标一律手写（`ui/icons.kt`，24 viewBox、stroke 1.7、圆头）。
- 「不静默失败」是硬规矩：失败要有**明确文案 + 一个可操作按钮**；清用户数据必须显式且二次确认。

---

## 9. 当前提交与推送状态

- `origin/main..HEAD` 有一批未推送提交（从「原生工程骨架」到本次「本地缓存 A 方案」）。
- 工作区仅 `package.json` 有改动（`piRuntimeVersion` 0.86.1→0.87.0，**不是本工作产生的**，未提交）。
- 推送前建议：先跑一次全量 `npm test`（项目规则：push main 前必须全量）。
- 本地缓存 A 方案的提交信息：`feat(android): 会话与首页列表本地缓存（秒开 + 断网可读）`。
