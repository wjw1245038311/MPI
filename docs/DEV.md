# MPI 开发说明（测试策略 · 代码地图 · 调试手段）

> 配合 `docs/RELEASE.md`（发版）与 `docs/E2E-TESTING.md`（测试基础设施手册）看。
> 目标：改代码时不用问「这次该跑什么、改这里会不会炸别处」。

## 1. 测试：什么时候全量、什么时候局部

### 1.1 分层

| 层 | 命令 | 抓什么 | 时间 |
|---|---|---|---|
| **L0 静态** | `npm run typecheck`（改 main/preload/renderer 后加 `npm run build`，确认 `out/main/index.js` 含改动） | 类型错误、模板串笔误、「改了源码但产物没更新」 | ~30 s |
| **L1 单元** | `npm test`（自动发现 `scripts/test-*.mjs`，独立进程） | 纯逻辑边界、回归用例 | **全量 ≈ 4–5 min**（127 个套件） |
| **L2 e2e** | `node scripts/e2e/harness.mjs [case-id]` | agent 行为闭环（LLM 参与，走本地 relay） | 1–3 min/case，不进 CI |
| **L3 真机冒烟** | 重启 MPI 手点 checklist | Electron/IPC/renderer 层（harness 覆盖不到） | ~5 min |
| **手机端** | `cd mobile/app && JAVA_HOME=<MyWorkspace>/Software/jdk21 ./gradlew assembleDebug :app:testDebugUnitTest` | Kotlin 逻辑 + 编译 | ~30 s |

### 1.2 按爆炸半径定范围（核心规则）

| 改动规模 | 判定 | 要跑的 |
|---|---|---|
| **小** | 单模块 / 单一功能域（某个面板、某条链路） | `npm run typecheck` + **相关套件**（子串过滤：`npm test -- memory` = 跑所有名字含 "memory" 的套件） |
| **手机端** | `mobile/app/`（Kotlin / Compose） | gradle 那条命令。**桌面侧套件只在同时改了 `src/` / `protocol/` / `mobile/shared/` 时才跑** |
| **大** | 跨模块，或动共享基础设施的**公共部分**（`store.ts` / main 入口 / pi-bridge / 构建配置 / `package.json` 依赖） | `npm run typecheck` + **全量 `npm test`** |
| **发版前** | 改版本号 / 打 tag / 出安装包 | **全量一次** |

**只有「大」与「发版前」才跑全量。** `push`、`commit`、「顺手验证一下」**都不是**全量的理由——
按爆炸半径选完就跑，别抢跑；拿不准先问一句，不要默认全量。

- 按**爆炸半径**判，不按文件名：`ipc.ts` 里改个局部函数（如某条远程广播）算小改 →
  typecheck + 相关套件；动它的共享状态/分发逻辑才算大。
- 拿不准宁多跑，但单文件局部改动不要反射性全量。
- 反例（2026-09-24）：只改了手机端抽屉样式 + 一条图片渲染，却提前跑全量 `npm test`（4–5 min），
  其中 `pool-write` 还是纯阈值抖动——白等还制造噪声。

### 1.3 常用命令

```bash
npm run typecheck                 # L0，改完必跑
npm test                          # L1 全量（≈4–5 min）
npm test -- memory                # 只跑名字含 memory 的套件
npm test -- remote pwa relay      # 多个过滤词
npm run test:zhiya                # 单套件入口（名字见 package.json 的 scripts）
npm test -- --list                # 列出会自动发现哪些套件（不经过滤）
node scripts/test-manual-sync.mjs # changelog / 手册约定校验（发版前）
```

- 运行器会优先取 `package.json` 里的 `test:<name>`（保证 flags 一致），找不到才回退默认命令。
- 环境缺失的套件会 **SKIP** 而不是失败（`tui-spawn`、`tui-resume`、`local-voice` 需额外条件）。
- `npm test` 的失败要看**是不是本改动引起的**：`pool-write` 这类带性能阈值的套件会偶发抖动，重跑一次再判断。

### 1.4 改/加测试的纪律

- 新功能的 L1 用例：新建 `scripts/test-<name>.mjs`（自动发现），并在 `tests/registry/` 加对应条目
  （`test-test-registry` 会校验注册表结构；`logic-*` 用 `logicTest`、`scenario-*` 用 `harnessCaseId`）。
- **bug 修复必须带回归用例**，否则不算修完。
- 提交时把验证方式写进 `changelog.md` 的 `Unreleased`（含具体命令 + 应用内怎么点）。
- 用户手册与 changelog 的同步用 `scripts/manual-sync.mjs`（配 `.pi/skills/user-manual` skill）。

## 2. 代码地图与改动纪律

| 位置 | 职责 | 改动注意 |
|---|---|---|
| `src/main/` | Electron 主进程：设备/工具/记忆/远程主机（`remote/`）、中继 uplink、IPC、（`app-updater.ts` 等） | 改了**必须重启 dev 实例**才生效；动 `store.ts` / 入口 / pi-bridge / 依赖 → 算大改，跑全量 |
| `src/preload/index.ts` | 渲染层与主进程的唯一桥（`window.pi.*`） | 新增 IPC 要同时改 preload + `index.d.ts`；旧实例缺新方法时要在调用处显式提示「重启 MPI」 |
| `src/renderer/src/` | 界面（React）：对话框/设置/面板/远程控制面板 | 改完 `typecheck` + 对应面板的套件；纯渲染层不必跑全量 |
| `src/shared/` | 主进程与渲染层共享的纯逻辑（`image-notes` / `task-mode-catalog` / `tool-trust-meta` / `app-update-feed`） | 两端都在用：改一处要跑**两端**的相关套件 |
| `protocol/remote-v1.schema.json` | 远程协议 v1 契约 | 改协议 = 跨端改动：桌面 + PWA + 安卓 + 中继都要对齐，跑全量 |
| `mobile/shared/protocol.ts` | 手机两端共用的协议常量/类型（PWA 与安卓同源） | 同上，注意两端各有一份等价实现（如 `user-text.ts` / `ImageNotes.kt`） |
| `mobile/pwa/` | 手机网页版（中继托管，`?dbg=1` 调试浮层） | 改完 `npm test -- pwa`；构建产物要重新部署到中继才生效 |
| `mobile/app/` | 安卓原生端（Kotlin/Compose） | 跑 gradle 那条；**只在同时动了 `src/` / `protocol/` / `mobile/shared/` 时才跑桌面套件** |
| `mobile/relay/index.mjs` | 自建中继（帧路由 + 静态托管 + WebPush） | 改完跑 `npm test -- relay`；**线上要 scp 重部署 + 重启 systemd 才生效** |
| `signaling/` | 旧 WebRTC 信令服务（已无客户端使用，默认禁用） | 保留但无 UI 入口；动它没有实际使用者验证 |
| `scripts/` | 工具与 L1 测试（见 `docs/RELEASE.md` §5 清单） | 纯脚本改动跑 `--check` + 相关套件即可 |

## 3. 调试与取证

- **取证一律写 `mpi-diag.log`**：主进程用 `appendDiagLog`。⚠ 重启后主进程的 `console.*`
  不再进 `logs/dev-run.log`（会静默丢），排查时别只盯 stdout。
- **先加日志再动手**：这类问题（跨 接口→转发层→回调 多层）白查多轮的根因都是「链路上某层静默 return」——
  先给每层加一行取证（帧类型/长度/连接号、参数计数），再判断。
- **渲染层/手机端**：PWA 与壳支持 `?dbg=1` 浮层（媒体权限、连接、UA 等）；Electron 渲染层用 devtools。
- **直接 node 跑 TS**：`node --experimental-strip-types scripts/…mjs` 或 `--experimental-transform-types`
  （需要时用 `scripts/ts-ext-loader.mjs` 解析无扩展名 import）；`electron-stub*.mjs` 给主进程代码提供假 electron。
- **L2/应用内测试面板**：`docs/FEATURE-TESTING.md`（用例注册 + 面板操作）；harness 用 `--list` 看用例。
- **手机端调试**：`scripts/mobile-dev-harness.mjs`（真协议 + 假 `service.handle`）；真机日志看 App 内诊断页。

## 4. 提交与协作约定

- 注释、文档、commit message **一律中文**（专业术语除外）；commit 用前缀式摘要
  （`fix(xxx):` / `feat(xxx):` / `docs:` / `chore(xxx):` / `release: vX——摘要`）。
- 每次改动追加到 `changelog.md` 的 `## Unreleased`（每条附独立一行的「验证方式：」）；
  发版时整节改名为 `## vX.Y.Z（日期）`，**不留空 Unreleased**。
- 远端有两个：`origin` = 自建 GitLab，`github` = 公开仓（CI 在这里跑）。**push 前先说明、等确认**。
- 不能确定 / 做不到的事直说，不编造；给备选要说明代价与「已验证 / 未验证」。
