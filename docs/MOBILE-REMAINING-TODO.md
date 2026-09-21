# 手机端剩余问题交接（可直接交给本地模型执行）

本文件是**自包含**的：新会话不需要上下文也能按条目开工。每条含「现状 / 目标 / 涉及文件 / 验收 / 预估」。
先读 §0 的环境与状态，再按 §2 的排序挑一条做。

## 0. 当前状态（截至 v0.6.15 / APK 0.2.1）

- 分支 `feat/mobile-relay`（已推送 origin，**未合 main**）。最近提交：`68dfd58`（权限实时同步）、
  `ac885c3`（P5-3/P5-6）、`ee12813`（P1 新建会话）、`1116e14`（S1 面板图标头）；再前是 `4f81b15 release: v0.6.15`。
- ✅ **已部署**（2026-09-15）：PWA 新构建（index-CQEg0IcI.js / index-CmLGSc0R.css，含 P1/P5-3/权限同步）
  与带 github 字段的 APK 清单已上中继并验证（manifest grep github ✓、index.html 引用新哈希 ✓、JS 200 ✓）。
- 已交付并验收：手机云中继（配对/会话流/发消息/审批卡/WebPush/通知深链）、安卓壳（壳内扫码 + APK 自更新 +
  三通道下载）、手机端多设备、飞书式信息架构（对话即主页 / 头像抽屉 / 二级设备抽屉 / 返回键逐级）、
  视觉令牌与图标对齐桌面端并跟随系统明暗。
- 产物：`MPI-Setup-0.6.15.exe`、`MPI-Android-0.2.1.apk`（均在 Seafile `Agent/`，APK 也在中继
  `/download/mpi-android-0.2.1.apk`）。
- 关键文档：`docs/MOBILE-DESIGN.md`（设计与部署）、`docs/ANDROID-SHELL.md`（壳的构建/发布/联调）、
  `docs/MOBILE-UX-PLAN.md`（四阶段计划）、`docs/REMOTE-PANEL-POLISH.md`（桌面面板视觉工单，未做）。

## 0.1 环境与踩坑速查（**先看这段，能省半小时**）

| 事项 | 做法 / 坑 |
| --- | --- |
| 安卓构建 | `cd android && JAVA_HOME='<MyWorkspace>\Software\jdk21' ./gradlew assembleDebug`；SDK 在 `<MyWorkspace>\Software\android-sdk`；Gradle 8.10.2 |
| `local.properties` | `sdk.dir` **必须正斜杠**（`E:/MyWorkspace/...`），反斜杠会被 properties 当转义 → 报「文件名、目录名或卷标语法不正确」 |
| 依赖源 | Gradle/Adoptium 官方下载 307 跳 github（被墙）→ wrapper 已指向华为镜像，JDK 走清华镜像 |
| PWA 构建 | `cd mobile/pwa && NODE_ENV=production npm run build`；**必须显式 production**，否则打出 React 开发版（417KB vs 218KB） |
| 发布 APK | `node scripts/publish-android.mjs [--github]`：出产物 + 拷 Seafile；`--github` 需 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:10808` |
| 中继部署 | `mobile/relay/index.mjs` 在 aliyun-ecs `/opt/mpi-relay`；SSH helper 在 `%TEMP%/ecs-ssh`（`run-any.mjs` 带 `SSH_HOST`、`upload.mjs`，密码走 `ECS_PWD`，远端路径要加 `MSYS_NO_PATHCONV=1`）；改完 `systemctl restart mpi-relay` |
| 静态部署 PWA | 上传 `dist/index.html` + `dist/assets/*`（**JS 与 CSS 都要传**，改样式后哈希会变）到 `/var/www/mpi-mobile/` |
| 模拟器 | 雷电 `F:/leidian/LDPlayer14/ldconsole.exe launch --index 0`；**它会抢 0.0.0.0:2222 = GitLab SSH 端口**，用完必须 `quit --index 0` 否则 `git push` 失败 |
| 模拟器联调 | 宿主转发 `127.0.0.1:9443 → <relay-tailnet-ip>:9443` + `adb reverse tcp:9443 tcp:9443` + 壳地址用 `https://127.0.0.1:9443/`（debug 构建放行该域证书） |
| WebView 调试 | `adb shell cat /proc/net/unix | grep webview_devtools_remote` → `adb forward tcp:9222 localabstract:<sock>` → `http://127.0.0.1:9222/json/list` 接 CDP |
| 工具 | 这台机器上 `python` 是 Store 假入口会**挂住**，用 `node`；git bash 里 `&` 后台会打乱 cwd，用绝对路径 |
| 验收基线 | `npm test`（56 passed/3 skipped）、`npm run typecheck`、`cd mobile/pwa && npx tsc --noEmit` |

## 1. 剩余问题清单

### ~~P1 手机端「新建会话」入口~~ ✅ 已完成（`ee12813`，待部署 + 真机验收）

- 抽屉顶部「新建会话」（多项目内联选择）→ `thread.create` → 自动进对话；开抽屉顺手刷新列表。
  pwa-actions Part2 H 段补了 home 级 Requester→真实 RemoteService 全链路断言。

### P2 GitHub 备选下载源 🟡 GitHub 侧已完成，剩清单上中继

- ✅ APK 已传 `android-v0.2.1`（**pre-release**）、直链 sha256 与本地一致、`/releases/latest` 未受影响。
  ⚠ 发现：GitHub 镜像最新稳定版是 **v0.6.14**——v0.6.15 还没同步到 GitHub（属 P6），不影响桌面更新器。
- **现状**：中继与 Seafile 两条通道可用；GitHub Release 已上传。
- **目标**：网络可达时补上：`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:10808 node scripts/publish-android.mjs --github`，
  然后把 `android/publish/mpi-android.json` 重新上传到中继（桌面端「手机 App」卡片读它拿 github 字段）。
- ⚠ **必须标 pre-release**（脚本已内置）：桌面端自更新用 electron-updater，`allowPrerelease=false` 时会取
  GitHub `/releases/latest` 定标签再找该标签下的 `latest.yml`；安卓包若成「最新稳定版」→ 桌面更新检查 404。
- **验收**：`curl -I` 直链 200 且 sha256 与本地一致；GitHub `/releases/latest` 仍指向 `v0.6.15`。
- **预估**：10 分钟（纯网络问题）。

### P3 桌面设置面板视觉优化 🟡 S1 已完成（`1116e14`），S2–S6 未做

- **现状**：`docs/REMOTE-PANEL-POLISH.md` 已写好 S1–S6 工单；**S1（图标头）已执行并验收**
  （明暗双主题 electron 截图 + typecheck + 全量基线），icons.tsx 新增 QrCode/Cloud。
- **目标**：按该文档继续做 **S2–S6**（层级重排、二维码统一、表单统一、空态、动效）。
- **注意**：只改样式与 JSX，不碰 `remote:*` IPC；不在 `.set-card` 内放 `position: fixed`（会跳）。
- **验收**：每步 `npm run typecheck` + 面板逐条对照文档的验收；纯 renderer 改动 `Ctrl+R` 即可见。
- **预估**：S1 ≈ 15 分钟，全套 1.5 小时。

### P4 真机未验证项（需要用户参与，模型只能准备）

- **扫码解码**：模拟器虚拟摄像头是绿屏，只验到「相机拉起 + 取景 + 权限」。真机扫码后应自动配对。
- **自更新真实升级**：用「清单声明更高版本、包仍是旧版本」验证了全链路（检查→提示→下载→sha256→安装器→
  InstallSuccess），但没跑过真正的版本升级。
- **保活/通知**：壳内**不做**推送（已拍板）；浏览器 PWA 的 WebPush 需要手机有 Google Play 服务且能连 Google。
  无 GMS 的国行机建议换国内通道（飞书机器人 / Server酱 等）——**未实现，属设计变更，需用户拍板**。

### P5 小项（零散，可批量做）

1. **手机端设置项缺失**：只有跟随系统明暗，没有主题/字号/语言（PWA 目前 zh-only）开关。
2. **`?dbg=1` 诊断浮层**仍在代码里（`mobile/pwa/src/DbgOverlay.tsx` 等约 5 处埋点）——正式发布前决定去留。
3. ~~**壳内提示去浏览器配对以获得推送**~~ ✅ 已完成（`ac885c3`）：壳环境首页顶部可关闭提示条，按 hostId 记 localStorage。
4. **Android 侧无真正单测**：目前只有 `scripts/test-remote-protocol.mjs` 的源码级断言（已覆盖壳能力）；
   若要加 JVM 单测需引入 junit + test source set（评估过，暂未做）。
5. **桌面端「已配对手机」管理**：RemotePanel 只有列表 + 移除，没有在线状态/最后活跃/重命名。
6. ~~**壳与 PWA 的契约同步**~~ ✅ 文档部分已完成（`ac885c3`）：`docs/ANDROID-SHELL.md` 新增显式「壳契约」小节
   （MpiShell 清单 / `__mpiBack` 握手 / VIEW filter / 兼容规则）。

### P6 分支收尾（需要用户决定）

- main 合并时机、GitHub 镜像同步、`feat/mobile-relay` 是否直接 fast-forward。
- 本分支的 changelog 已归到 `v0.6.15`；若合并到 main 后还要发版，按 `npm run dist` 流程再走一次。

## 2. 建议执行顺序

已完成：~~P3-S1~~、~~P1~~、~~P2-GitHub侧~~、~~P5-3~~、~~P5-6文档~~、权限实时同步（`68dfd58`）、**部署上中继**。剩余：

1. ~~**部署**~~ ✅ 已完成（2026-09-15，SFTP 4 文件 + curl 验证）。⚠ 权限实时同步还需**重启桌面实例**（main 进程改动，Ctrl+R 不够）；手机浏览器若缓存旧 index.html 则关掉标签页重开。
   ```bash
   cd /e/MyWorkspace/Project/MPI && MSYS_NO_PATHCONV=1 ECS_PWD="<ecs root 密码>" node "$TEMP/ecs-ssh/upload.mjs" \
     "E:/MyWorkspace/Project/MPI/mobile/pwa/dist/index.html" "/var/www/mpi-mobile/index.html" \
     "E:/MyWorkspace/Project/MPI/mobile/pwa/dist/assets/index-CQEg0IcI.js" "/var/www/mpi-mobile/assets/index-CQEg0IcI.js" \
     "E:/MyWorkspace/Project/MPI/mobile/pwa/dist/assets/index-CmLGSc0R.css" "/var/www/mpi-mobile/assets/index-CmLGSc0R.css" \
     "E:/MyWorkspace/Project/MPI/android/publish/mpi-android.json" "/var/www/mpi-mobile/download/mpi-android.json"
   ```
   验证：`curl -sk https://<relay-tailnet-ip>:9443/download/mpi-android.json | grep github`；手机刷新 PWA 应见「新建会话」与壳内提示条。
   ⚠ 权限实时同步还需**重启桌面实例**（main 进程改动，Ctrl+R 不够）。
2. **P3-S2–S6**（按 REMOTE-PANEL-POLISH.md 继续）
3. **P5-1 / P5-5**（零散体验项：PWA 设置开关；已配对设备在线状态/最后活跃——不加新 IPC，重命名需拍板）
4. **P4**（需用户配合，先准备清单）
5. **P6**（用户拍板；注意 GitHub 镜像还停在 v0.6.14）

## 3. 不要做的事（避免踩坑）

- 不改 `remote:*` IPC 协议或 E2E 加密（改协议要同时改 PWA/relay/host 三端 + 测试）。
- 不引入 UI 库/图标库/CSS 框架；图标一律手写 SVG，风格照 `mobile/pwa/src/components/icons.tsx`
  与 `src/renderer/src/components/icons.tsx`（24 viewBox、stroke=currentColor、1.7、圆头）。
- 手机端新增样式**只用桌面端同名令牌**（`--bg/--surface/--border/--text/-dim/-faint/--accent/--accent-soft/--send/--radius/--font`），
  不要再引入 `--panel` 这类旧别名（它们只是过渡兼容）。
- 发布 APK 时不要忘记 `android/app/build.gradle.kts` 里 `versionCode` 必须递增（否则安装器会当成同版本）。
- 不要把 `android/publish/`、`android/local.properties`、`scripts/.dbg-*` 提交进仓库（已在 `.gitignore`）。
