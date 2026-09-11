# MPI 全仓综合 Review —— v0.5.3（2026-09-11）

> 范围：src/main（含 messaging/、remote/、weixin/）、src/preload、src/renderer、lib。
> 基线：typecheck + 27 项测试套件（drafts/todos/quickadd/config/markdown/diff/compactions/toolargs/permission/pinnedorder/migration/npmcommand/trash/backup/messaging/commandparse/channelcmd/channelext/wechat/searchtrash/chatsearch/model-context/model-autopilot/usage/html-reference/remote-signaling）+ electron-vite build，修复前后全绿。
> 方法：逐模块通读 main 全部文件与 renderer store/核心组件；tsc --noUnusedLocals/--noUnusedParameters 临时开启扫死代码；setInterval/console.log/订阅泄漏等定向 grep。
> 注：`test:remote` 失败是本机缺 `android/` 源码目录（环境问题，非回归）；`test:commandparse` 偶发 libuv 退出断言（Windows teardown 已知问题，重跑 3 次全过）。

## 一、已直接修复的小问题（7 项 + 1 个正式开关）

| # | 位置 | 问题 | 处理 |
|---|------|------|------|
| 1 | `messaging/wechat-service.ts` runJob | **真 bug：事件订阅泄漏**。`subscribeThread` 返回的 `unsubscribe` 声明后从未调用——每完成一条微信消息，remoteEventHub 上就多一个永久监听器（闭包持有旧 buffer，持续接收该线程全部事件）。飞书 service 在 finally 里正确调用了，微信漏了 | `let unsubscribe` 提升到 try 外 + finally 中 `unsubscribe?.()`（与飞书对齐） |
| 2 | `messaging/wechat-service.ts` | （#1 的连带）tsc --noUnusedLocals 扫出的未使用变量即此 bug 的信号 | 随 #1 修复 |
| 3 | `data-migration.ts` | 死函数 `currentEffectiveSessionsDir()`（声明后无任何调用方） | 删除 |
| 4 | `ipc.ts` todo inbox | `todoInboxWatcher` 变量赋值后从未读取；`FSWatcher` 类型导入随之变死。channel-command inbox 本来就不保留句柄（Node 的 fs.watch watcher 不依赖引用存活，close()/进程退出前一直有效） | 改为无赋值调用 + 注释说明，删 `type FSWatcher` 导入 |
| 5 | `automation.ts` / `todo-attachment-protocol.ts` / `AboutPanels.tsx` / `store.ts` | 未使用导入 ×4：`join`(node:path)、`statSync`(node:fs)、`formatBytes`、类型 `PreviewPayload` | 删除 |
| 6 | `tsconfig.json` + `tsconfig.node.json` | **正式开启 `noUnusedLocals: true`**（上次 review 的建议，防死代码复发）。`noUnusedParameters` 保持关闭——Sidebar 的 `onOpenRemote/remoteOpen` props 是有意保留的死 prop（注释注明 P1-10 恢复远程入口时加回按钮），开了会误伤 | 已开启；修复后两个工程零告警 |
| 7 | `session-store.ts` getTotalUsage | **Sidebar 每 60s 全量扫盘**：每次轮询都重新 parse 全部会话 JSONL。改为 mtime+size 增量缓存（见下） | 已实现 + test:usage 新增 3 组用例 |

### #7 用量统计增量缓存（用户拍板后当日完成）
- `getTotalUsage()` 内部加 `Map<文件路径, {mtimeMs, size, tokens, cost, todayTokens, todayCost}>`：每次调用先 statSync 全部文件（只读元数据），(mtimeMs,size) 与缓存一致→直接取上次结果不打开文件；只有变过的才重新 parse（稳态=通常仅活跃会话一个）
- **跨天失效**：“今日”桶相对本地零点，检测到日期变化时清整个缓存全量重算一次（每天最多一次全扫）
- **删除剪枝**：每次调用用存活文件集清理已删会话的缓存项；切换数据存储目录无需特殊处理（新路径自然 miss、旧条目被剪枝）
- 导出 `resetUsageCache()` 测试钩子
- test:usage 新增：①缓存命中证明——把 b.jsonl 原地改成同长度垃圾内容并精确恢复 mtime，若重读则 JSON.parse 全失败→总量必变，结果不变即证明走了缓存；②变更文件单独重算（混合 hit/miss 聚合正确）；③删除后剪枝
- ⚠️ 测试踩坑：NTFS FILETIME 是 100ns 精度，经 float64 秒数往返会丢亚毫秒位且**不确定性地**偏几个 tick——所以测试先把 mtime 钉到整秒再损坏/恢复（int64 路径精确），5/5 稳定

修复后复扫：`tsc --noEmit`（node + renderer）**零告警**；typecheck、27 项测试、build 全过。
未提交 git——工作区还有大批 WIP（微信渠道/模型 auto/contextWindow 探测/数据存储迁移/会话内搜索），等验证后一起处理更干净。

## 二、无法直接拍板的问题（待你审查）

### A. 飞书 / 微信两个 channel service 约 300 行近重复代码（用户拍板：在其它会话修复）
`messaging/service.ts`（823 行）与 `messaging/wechat-service.ts`（759 行）中，命令处理层几乎逐行相同：
- `/new`、`/list`、`/use <n>`、`/help`、自然语言短语分发（parseChatCommand switch）
- `recentThreads()` / `resolveSwitchTarget()` / `applySwitch()` / `handleBackCommand()`（"上一个"乒乓）
- `handleChannelCommand()`（mpi_channel_* 工具回调）、`ensureThread()`（按标题找专属会话）、`createThread()`、`setActiveThread()`（registryChain 串行注册）、`persistActiveThreadId()`、`rememberSeen()` 去重、T 文案表

真正不同的只有传输层：飞书=WebSocket 长连接 + **消息原地更新**（流式刷新同一条 ack）；微信=iLink getUpdates 长轮询 + **只能发新消息**（无 update 原语，有 typing ticket）。
**建议**：抽一个 `ChannelBase`（命令分发/会话解析/registry 同步/去重），两个 service 只实现 `deliver()`（流式更新 vs 新消息）与连接生命周期。净删 ~300 行，且 #1 这类“飞书修了微信漏了”的 bug 以后只会发生一次。**但这是 WIP 代码**——建议等微信渠道在你设备上验证通过后再动，避免重构干扰验证。

### B. Sidebar 用量统计每 60s 全量扫盘 ✅ 已完成（mtime+size 增量缓存，见上 #7）
`Sidebar.tsx` 打开时每 60 秒调 `app:getTotalUsage()` → main 的 `getTotalUsage()` **流式解析全部会话 JSONL 的每一行**（8 并发）求 token/cost 总和。几十个中小会话无感；但会话多且大时（几百个/GB 级），等于每分钟一次全量磁盘读 + JSON parse，CPU/IO 持续占用。
**建议方案**（任选其一或组合）：
1. main 侧按 `文件路径+mtime+size` 做增量缓存：未变动的文件直接取上次结果，只有新写入的会话才重算（终端 pi 活动也能被 mtime 变化捕获，语义不变）；
2. 轮询间隔放宽到 5min + 保留"流式结束即刷新"（现有逻辑已有），牺牲一点实时性换零后台开销。

### C. 上次 review（09-09）遗留、仍待拍板的项
1. **APP_UPDATE_DISABLED 死链** ✅ 已完成（用户拍板：接到自己的仓库 wjw1245038311/MPI）。`app-updater.ts` 删常量+三处 guard，REPOSITORY/build.publish 均改为 `wjw1245038311/MPI`；新增 friendlyUpdaterError()（无 release/网络不通时中文提示）；工作仓加 `github` remote。发布流程：大版本 dist/ 产物挂 GitHub Release（exe+latest.yml+blockmap）。changelog Unreleased #17。
2. **i18n DOM 桥接脆弱**（上次 C 项）：`lib/i18n.ts` 靠 exact/prefixes/regex 翻译 DOM 文本，新增中文 UI 文案必须同步字典，漏了就是英文界面里混中文。长期正解是组件内直接走 t() 函数。
3. **prompt/steer/followUp 三 IPC 可合并**（上次 D 项）：倾向不动——三个动词语义清晰，合并收益小。
4. **.gitignore `android/*` 残留**（上次 F 项）：android 源码不在本仓，忽略规则无实际作用但无害；若确定不提交安卓端可删。
2. **i18n DOM 桥接脆弱**（上次 C 项）：`lib/i18n.ts` 靠 exact/prefixes/regex 翻译 DOM 文本，新增中文 UI 文案必须同步字典，漏了就是英文界面里混中文。长期正解是组件内直接走 t() 函数。
3. **prompt/steer/followUp 三 IPC 可合并**（上次 D 项）：倾向不动——三个动词语义清晰，合并收益小。
4. **.gitignore `android/*` 残留**（上次 F 项）：android 源码不在本仓，忽略规则无实际作用但无害；若确定不提交安卓端可删。

## 三、整体评价（无需行动）

- **性能设计到位**：事件按帧批处理（scheduleEventFlush）、MessageGroup memo + toolRuns copy-on-write、Markdown 插件数组模块级常量、warm spare pi 进程（冷启动 5s→0.5s）、remote projects 30s 缓存。流式期间只有活跃消息组重渲染，历史零开销。
- **竞态处理成熟**：TUI generation token、飞书串行化更新管道 + 最终稿重试保底、微信 getUpdatesBuf 游标持久化、draft LRU、乐观气泡失败回滚——都是踩坑后加固过的，注释里留了根因说明。
- **安全边界清晰**：remote 路径逃逸双重 realpath 校验、敏感文件名单、事件值脱敏（remoteSafeEventValue）、飞书 secret/微信 token 永不跨 IPC、备份导入 sanitize 白名单。
