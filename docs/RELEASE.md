# MPI 发版与工具清单

> 一页说清「怎么发一版、发到哪、有哪些现成工具」。
> 只记 §1 的 5 条铁律就够；其余是索引，需要时查。

## 1. 铁律

1. **不等 GitHub 构建。**（反复踩过的坑）GitHub 只当异步备份：tag 推上去让 CI 自己出 Release 附件，
   本机**既不轮询、也不等待**。发版命令默认就是 `--local`，不要改成 `--wait-ci`。
2. **本地包先发出去。**`npm run dist` 出包 → 直接分发到 **中继镜像（ECS）** 和 **Seafile**，
   与代码提交解耦（包好了就能发，不必等 commit / CI）。
3. **每次都校哈希。** 分发后必须核对：ECS 上 `sha256sum` / 文件大小 == 本地 `release/*.sha256`。
   对不上就是传坏了，重传。
4. **推送要确认。** 可以 commit；`git push`（分支 / tag）必须先说明变更、等用户确认。
   例外：`journal/` 各设备自管目录可直接推。
5. **发布前来一遍验证。**`npm run typecheck` + **全量** `npm test` + `node scripts/test-manual-sync.mjs`
   （发版前是全量的四个正当理由之一；日常改动按爆炸半径选范围，见 `docs/DEV.md` §1）。

## 2. 发一版（默认路径）

```bash
# 一键（推荐）：bump patch → changelog Unreleased 改名 → commit → push origin → npm run dist
#               → publish-release --local（中继镜像 + Seafile）
node scripts/dev-release.mjs

# 分步（要精细控制时）
#   ① 攒 changelog：把改动写进 changelog.md 的 ## Unreleased
#   ② 改版本号：package.json 的 version（x.y.z）
#   ③ 出包：npm run dist            → release/MPI-Setup-<v>.exe(+.blockmap/.sha256/latest.yml)
#   ④ 分发：npm run release -- <v> --local --seafile "E:/Seafile/wei_jw2/我的资料库/Agent"
#   ⑤ 提交并等确认后推送分支 + tag
```

`publish-release.mjs` 的参数：

| 参数 | 作用 |
|---|---|
| `--local` | **默认路径**：本机不传 GitHub、不等 CI；安装包走本地产物 → 中继镜像 + Seafile |
| `--seafile <dir>` | 额外复制 exe + `.sha256` 到 Seafile 分发目录 |
| `--no-relay` | 跳过中继镜像（客户端会回退 GitHub）。**只在确认不推 ECS 时用** |
| `--no-push` | 不推分支 / tag |
| `--wait-ci [分钟]` | 老行为：不本地传，轮询等 CI 附件。默认 20 分钟，**平时不要用** |
| `--force-upload` | 本地产物覆盖 GitHub Release 上同名附件（平时不用，GitHub 交给 CI） |

环境变量：`MPI_RELAY_HOST`（默认 `root@100.67.5.31`）、`MPI_RELAY_APP_DIR`
（默认 `/var/www/mpi-mobile/download/app`）、`GITHUB_TOKEN` 或仓库根 `.gh-token`。

## 3. 分发点

| 分发点 | 内容 | 谁在用 |
|---|---|---|
| **中继镜像（ECS）** `<中继>/download/app/` | `latest.yml` + `MPI-Setup-<v>.exe` + `.blockmap` | **桌面自更新主源**（`src/main/app-updater.ts`：中继优先 → GitHub 回退） |
| **中继（ECS）** `/var/www/mpi-mobile/download/` | `mpi-android*.json` 清单 + APK + patch | 手机 App 更新主源 |
| **Seafile** `E:/Seafile/wei_jw2/我的资料库/Agent` | 桌面 exe + `.sha256`、安卓 APK | 局域网分发 / 手机直接下 |
| **GitHub Release** | 同上（CI 异步上传） | 公网备份、别人安装 |
| 中继静态服务本体 | `/var/www/mpi-mobile`（PWA + 上面两个 download 目录） | 手机 PWA / 附件 |

**中继部署**：`scp mobile/relay/index.mjs root@<ecs>:/opt/mpi-relay/ && ssh root@<ecs> 'systemctl restart mpi-relay'`
（systemd 单元 `mpi-relay`；改了中继代码要重部署，否则线上还是旧行为）。

## 4. 两条发布线（互不依赖）

| | 桌面端 | 手机端（原生 App） |
|---|---|---|
| 版本号 | `package.json` version | `mobile/app/app/build.gradle.kts` 的 versionName/versionCode |
| 出包 | `npm run dist` | `cd mobile/app && JAVA_HOME=<MyWorkspace>/Software/jdk21 ./gradlew assembleDebug` |
| 一键发布 | `node scripts/dev-release.mjs` | `node scripts/dev-publish-android.mjs`（开发期）/ `scripts/publish-android-github.mjs`（正式） |
| 更新通道 | 中继 `download/app/latest.yml` → GitHub | 中继 `download/mpi-android-native.json` → GitHub（清单里 `url` 可为绝对地址） |
| 校验 | `release/*.exe.sha256` | APK `.sha256` + 清单里的 `sha256` |

## 5. 工具清单

### 发版 / 分发
| 工具 | 用途 |
|---|---|
| `scripts/dev-release.mjs` | 一键发版（bump → changelog → commit → push origin → dist → `--local` 分发） |
| `scripts/publish-release.mjs` | 桌面发布：GitHub Release + 中继镜像 + Seafile（配合 `npm run release`） |
| `scripts/write-sha256.mjs` | dist 流程里给每个安装包写 `.sha256` sidecar |
| `scripts/dev-publish-android.mjs` | 开发期安卓发布：本机 SeaDrive + ECS 公网下载点，自动写清单 |
| `scripts/publish-android-github.mjs` | 原生 App 正式发布：GitHub Release + 增量 patch + 清单 |
| `scripts/publish-android.mjs` | 旧 WebView 壳 APK 发布（历史产物，仍可用） |
| `scripts/make-apk-patch.mjs` | 生成 rsync 风格（4KB 块）APK 增量包 |
| `scripts/manual-sync.mjs` | 用户手册差分：列出「changelog 有、手册没同步」的条目（配 user-manual skill） |
| `scripts/test-manual-sync.mjs` | 手册同步工具的自测 + changelog 结构校验（发版前跑） |

### 构建 / 打包
| 工具 | 用途 |
|---|---|
| `npm run dist` | 完整桌面发布包（= bundle + build + electron-builder + sha256 + finalize-runtime） |
| `npm run pack` | 同上但只出目录（调试用，不打安装包） |
| `scripts/bundle-runtime.mjs` | 打内置 pi runtime 归档（装进安装包） |
| `scripts/finalize-runtime.mjs` | 把 runtime 归档拷到 Electron 产物旁（QA / Seafile 用） |
| `scripts/build-app-pack.mjs` | 把示例 app 打成自包含 app 包（`--app=examples/apps/xxx`） |
| `scripts/build-tui-race-bundle.mjs` | 为 `test-tui-race.cjs` 打 CJS bundle（electron 走 stub） |
| `scripts/gen-android-icon.mjs` | 由桌面图标生成安卓启动图标各密度 PNG |
| `scripts/gen-android-vectors.mjs` | 从 PWA 的 TS 实现生成 Android 侧 Kotlin 测试用的固定加密向量（改协议后必须重跑） |

### 开发 / 调试
| 工具 | 用途 |
|---|---|
| `npm run dev` | dev 实例（改主进程 / preload 需重启） |
| `scripts/dev-launch.mjs` / `scripts/restart-dev.sh` | 启动 / 重启 dev（避免被调用方中断时连带杀掉 dev） |
| `scripts/mobile-dev-harness.mjs` | 手机端 harness（只桩 `service.handle`，其余走真实协议） |
| `scripts/electron-stub.mjs` / `electron-stub-loader.mjs` / `ts-ext-loader.mjs` | 测试用 electron / TS 桩与 loader |
| `npm run check:ext`（`scripts/check-extensions.mjs`） | 扩展语法检查（`src/main/mpi-*-ext.ts` 不在 tsconfig 覆盖内） |
| `scripts/chat-attachments-maintenance.mjs` | 附件区维护：去重 / 引用感知 GC / 盘点 |
| `scripts/e2e/harness.mjs`、`scripts/search-mark/*` | e2e harness、markdown 搜索标记的 dom/integration 测试 |

### 诊断 / 基准
| 工具 | 用途 |
|---|---|
| `npm run diag:latency` | recall 延迟构成（embedding / 句柄 / 查询各占多少） |
| `npm run diag:extract` | 记忆抽取质量诊断（拿真实会话喂同一套提示词） |
| `scripts/diag-zvec-score.mjs` | 引擎分数语义诊断（对比手算余弦） |
| `npm run bench:memory` / `bench:memory-scale` / `bench:panel-scale` | 记忆池延迟、批量落盘、面板规模实测 |
| `scripts/zvec-probe-worker.mjs` | zvec 并发探针 worker（供 `test-zvec-index` 派生） |
| `scripts/edge-tts-live-check.mjs` | Edge TTS 真实网络冒烟（微软升客户端版本导致 403 时用） |
| `npm run check:switch` | 设备切换自检：这台机器的记忆写入口是否切好 |

### 记忆池
`npm run memory:<cmd>`（`scripts/memory-cli.mjs`）：`list` / `add` / `recall` / `reindex` / `show` /
`optimize` / `proposals` / `forget` / `archive` / `approve` / `reject` / `dream`；
另有 `npm run backfill:lessons`（给历史 lesson 补结构骨架）。

### 测试
`node scripts/run-all-tests.mjs [过滤词…]`（= `npm test`）：自动发现 `scripts/test-*.mjs`，独立进程，
命令优先取 package.json 里的 `test:<name>`。常用子集：
`npm test -- remote`、`-- pwa`、`-- relay`、`-- memory`、`-- choice`。
分层与约定见 `docs/E2E-TESTING.md`；测试注册表在 `tests/registry/`。
CI：`tests.yml`（PR + main push：typecheck + 全量 L1）、`build-installers.yml`（main push 打包；
`v*` tag 才发布 Release 附件）。

### 仓库外（工作区，不在版本控制里）
`Software/ecs443-tunnel/`（443 隧道池 + `ecs-range-proxy.py` 分片代理）、
`Software/Tailscale/derp-guard.sh`（DERP 守护）、`tempfile/`（一次性脚本与交接材料）。

## 6. 常见坑

| 症状 | 原因 / 处理 |
|---|---|
| 发版卡在「等待 GitHub Actions 附件」 | 用了 `--wait-ci`。停掉，改默认 `--local` |
| 客户端检查更新永远「已是最新」 | ECS 上的 `latest.yml` 落后（镜像没推成功）。重跑 `publish-release --local`；客户端侧也有「版本比当前旧就不信中继、转问 GitHub」的兜底 |
| 安装包下载不能断点续传 | 中继旧代码（无 Range）。重部署 `mobile/relay/index.mjs` |
| `origin`（GitLab）与 `github` 不同步 | 发版脚本会推两个远端；手动发版别漏了 `git push github main` |
| 中继代码改了但线上没生效 | 中继是独立进程：必须 scp + `systemctl restart mpi-relay` |
