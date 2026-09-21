# MPI 项目约定（AGENTS.md）

> 本仓特有的规则（pi / 其它 agent 在本目录工作时自动加载）。
> 个人偏好见知芽「人物画像」（`Persona.md`），协作规则见「协作约定」（`Agreement.md`），工作空间事实见「工作空间」（`WorkspaceLayout.md`）。

## 常用命令

```bash
npm run dev          # 开发（electron-vite；改了主进程 / preload 需重启）
npm run typecheck    # 两套 tsconfig 全量检查 —— 改完必跑
npm run build        # 构建到 out/
npm test             # 跑全部 L1 测试（scripts/run-all-tests.mjs）
npm test -- zhiya    # 只跑名字含过滤词的测试
npm run test:zhiya   # 等价的单套件入口，名字见 package.json 的 scripts
```

- 收尾门槛：至少 `npm run typecheck`；动了有测试覆盖的模块，跑对应 `test:*`（或 `npm test -- <名字>`）。
- 测试分层与约定见 `docs/E2E-TESTING.md`。

## 发版与分发

- **Seafile 是局域网分发放置点**：本地打包好的安装包直接同步过去（路径见 `WorkspaceLayout.md` 速查的 Seafile 条目）。文件名 `MPI-Setup-<版本>.exe` + `.sha256`；复制后校验哈希一致才算完成。
- **不要等 GitHub 构建**：网络与上行不稳，等 CI 出包只会拖慢分发。本地包先发出去，CI 异步跑。
- **GitHub 侧交给 CI**：版本提交与 tag（`v<版本>`）推送到 `main` 后，由 GitHub Actions 自动构建生成 Release 安装包；本机不做手工上传产物（`npm run dist` 只为本地 / Seafile 分发服务）。
- **发版顺序**：① 改 `package.json` 版本 ② `changelog.md` 的 `Unreleased` 小节改名为 `## v<版本>（日期）` ③ `npm run dist` ④ 复制 exe + sha256 到 Seafile 并校验 ⑤ 提交、等确认后推送分支与 tag（触发 CI）。
- **可先行**：第 ④ 步不等 git（也不等 CI），本地包就绪即可分发——分发与代码提交解耦。
