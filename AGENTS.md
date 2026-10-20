# MPI 项目约定（AGENTS.md）

> 本仓特有的规则（pi / 其它 agent 在本目录工作时自动加载）。
> 个人偏好见知芽「人物画像」（`Persona.md`），协作规则见「协作约定」（`Agreement.md`），工作空间事实见「工作空间」（`WorkspaceLayout.md`）。

## ⚠️ 发版铁律（只记这一句）

**发版不等 GitHub 构建。** 本机 `npm run dist` 出包后直接分发到**中继镜像（ECS）+ Seafile**，
GitHub 只让 CI 异步出 Release 附件（不轮询、不等待），**且只在大版本才推 GitHub**（小版本默认 `--no-github`）。
发版走 `node scripts/dev-release.mjs`，默认就是 `publish-release.mjs --local`——**不要改成 `--wait-ci`**。
完整规则、分发路径与工具清单：**`docs/RELEASE.md`**（发版前先读它）。

## 常用命令

```bash
npm run dev          # 开发（electron-vite；改了主进程 / preload 需重启，见下节）
npm run typecheck    # 两套 tsconfig 全量检查 —— 改完必跑
npm run build        # 构建到 out/
npm test             # 跑全部 L1 测试（scripts/run-all-tests.mjs）
npm test -- zhiya    # 只跑名字含过滤词的测试
npm run test:zhiya   # 等价的单套件入口，名字见 package.json 的 scripts
```

### 改动生效（改完 `src/` 后必做）

- **改了 `src/main/**`、preload、扩展源码或注册表文件 → 必须重启，`Ctrl+R` 不算。**
  `npm run dev` 的 watcher 在本机实测**不一定**重建 `out/`，正确姿势是用脚本（构建 + 重启一起做）：
  - `bash scripts/restart-dev.sh` —— 构建 → 结束旧实例 → detached 启动 → 校验
  - `--dry-run` 只报告要动哪些进程；`--no-build` 只重启
  - 只碰属于本仓的 `MPI Dev` 实例，不会误杀其它 Electron 应用
- **要验证任何主机侧改动，先确认 dev 已经重启过** —— 否则测到的是旧行为（「提前播报」那类后台场景已经踩过一次）。
- HMR 后界面状态异常（如看不到「思考中 · Ns」占位行）→ 先重启一次 dev 再排查，别读代码猜。
- 细节、安全边界与「为什么不能只杀进程」见 `docs/ANDROID-SHELL.md` 的「主机侧改动怎么生效」一节。

### 测试范围（默认不全量）

全量 L1 约 4–5 分钟，小改动每次跑是浪费时间——按改动规模定范围：

| 改动规模 | 判定 | 要跑的 |
|---|---|---|
| **小** | 单模块 / 单一功能域（如某个面板、某条 memory 链路） | `npm run typecheck` + 相关套件。套件名自描述（`test:<area>`，见 package.json scripts）；批量用子串过滤：`npm test -- memory` = 跑所有名字含 "memory" 的套件 |
| **手机端（`mobile/app/`）** | Kotlin / Compose 改动 | `cd mobile/app && JAVA_HOME=<MyWorkspace>/Software/jdk21 ./gradlew assembleDebug :app:testDebugUnitTest`（约 30s）。**桌面侧套件只在同时改了 `src/`、`protocol/`、`mobile/shared/` 时才跑** |
| **大** | 跨模块，或动共享基础设施的**公共部分**（store.ts / main 入口 / pi-bridge / 构建配置 / package.json 依赖） | `npm run typecheck` + 全量 `npm test` |
| **发大版本** | minor / major（`0.9.x → 0.10.0`、`1.0.0`），或本版含跨模块 / 共享基础设施改动 | `npm run typecheck` + **全量** `npm test` |
| **发小版本** | patch（`0.9.5 → 0.9.6`）且本版都是局部改动 | `typecheck` + 按爆炸半径选相关套件（**不必全量**） |

- **只有上面「大」与「发大版本」才跑全量；小版本（patch）按爆炸半径选。**`push`、`commit`、「顺手验证一下」**都不是**全量的理由——按爆炸半径选完就跑，别抢跑；拿不准先问一句，不要默认全量。
- 反例（2026-09-24）：只改了手机端抽屉样式 + 一条图片渲染，却提前跑了全量 `npm test`（4–5 分钟），其中 `pool-write` 还是纯性能阈值抖动——浪费时间且制造噪声。

- 按**爆炸半径**定范围，不按文件名：ipc.ts 里改一个局部函数（如某条远程广播）= 小改动 → typecheck + 相关套件（`npm test -- pwa`、`test:remote`），不跑全量；动它的共享状态/分发逻辑才算大。
- 拿不准算大还是小：宁多跑，但单文件局部改动不要反射性全量。
- 示例：改 `src/main/zhiya/*` → `npm test -- memory` + `npm run test:zhiya`；改 renderer markdown → `npm run test:markdown` + `test:slugs`；改 Chat.tsx/store.ts → 算大，全量。
- 测试分层与约定见 `docs/E2E-TESTING.md`；**测试策略全文、代码地图、调试取证手段见 `docs/DEV.md`**。

## 发版与分发

**发版先读 `docs/RELEASE.md`**（铁律 / 流程 / 4 个分发点 / 工具清单 / 常见坑）。下面是最短的几条：

- **Seafile 是局域网分发放置点**：本地打包好的安装包直接同步过去（路径见 `WorkspaceLayout.md` 速查的 Seafile 条目）。文件名 `MPI-Setup-<版本>.exe` + `.sha256`；复制后校验哈希一致才算完成。
- **不要等 GitHub 构建**：网络与上行不稳，等 CI 出包只会拖慢分发。本地包先发出去，CI 异步跑。
- **GitHub 侧交给 CI，且只在大版本推**：小版本（patch）默认 `--no-github`——不推 GitHub、不建 Release，只发中继镜像 + Seafile；大版本（`--minor` / `--major`）才把 tag 推上去让 GitHub Actions 出 Release 安装包；本机不做手工上传产物。
- **中继上传走公网 443、并发分片**：`scripts/relay-upload.mjs`（12 路，实测 137MB / 15.6s ≈ 8.8MB/s）；tailnet（`100.x`）是单条 DERP 隧道，并发无效（~0.8MB/s）。
- **发版顺序**：① 改 `package.json` 版本 ② `changelog.md` 的 `Unreleased` 小节改名为 `## v<版本>（日期）` ③ `npm run dist` ④ 复制 exe + sha256 到 Seafile 并校验 ⑤ 提交、等确认后推送分支与 tag（触发 CI）。
- **桌面端自更新跟随「设置 → 服务器」**：`npm run release`（`scripts/publish-release.mjs`）在 GitHub Release
  之外，还会把 `latest.yml` + `MPI-Setup-<v>.exe` + `.blockmap` scp 到中继静态目录
  `/var/www/mpi-mobile/download/app/`（env：`MPI_RELAY_HOST` / `MPI_RELAY_APP_DIR`）。
  客户端（`src/main/app-updater.ts`）**只在「服务器」选了内置服务器（我的 ECS）且填了授权码**时，
  先探测 `<镜像>/latest.yml`（5 秒超时，带 `Authorization: Bearer <授权码>`），不通或版本比当前旧
  就回退 GitHub；自定义服务器不镜像安装包 → 直接 GitHub。地址不在配置里，以混淆常量内置在
  `src/shared/builtin-server.ts`（**只是防 grep，不是安全边界**）。
  **该步骤失败默认中止发版**（镜像落后 = 客户端永远看不到新版本）；确实不推就加 `--no-relay`。
- **可先行**：第 ④ 步不等 git（也不等 CI），本地包就绪即可分发——分发与代码提交解耦。
- **发版本机不传 GitHub、不等 CI**：`npm run release` / `scripts/dev-release.mjs` 默认走 `publish-release.mjs --local`——
  安装包以 `release/` 下的**本地产物**分发（中继镜像 + Seafile），GitHub Release 的附件由 CI 异步发布。
  只有需要本地上传 GitHub（`--force-upload`）或确实要等 CI 产物（`--wait-ci [分钟]`）时才显式加参数。

### 打包时的两个坑（`npm run dist`）

- **`PI_PACKAGE_DIR` 必须指向与 `package.json` 的 `piRuntimeVersion` 一致的 pi 包。**（当前是 `1.3.0`；改动版本时跟着改。）
  `scripts/bundle-runtime.mjs` 会校验，不符直接抛 `PI_PACKAGE_DIR must contain Pi v<期望>; found v<实际>`——
  别指向全局 npm 装的那份（版本常比期望新一档）。兜底查找顺序：`PI_PACKAGE_DIR` → 全局安装 → `<userData>/runtime/versions/<版本>/pi`。
- **发行版在跑时没法起第二个实例做冒烟**：`src/main/index.ts` 有 `app.requestSingleInstanceLock()`，第二个实例会直接退出。冒烟前先彻底退出已运行的 MPI。

