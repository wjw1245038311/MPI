# 私有应用（不进版本库）

本目录用于放置**只给自己用**的 MPI 应用商店 app 包源码（例如与个人基础设施绑定的应用）。
它们**不进入版本库、不上传到任何远端**。

## 约定

| 位置 | 用途 | 是否入库 |
|---|---|---|
| `examples/apps/<id>/` | **公开示例**（如 `local-voice`），可被他人参考 | ✅ 入库 |
| `examples/apps/private/<id>/` | **私有应用**，含个人环境细节 | ❌ 不入库（本目录除本 README 外全部被 `.gitignore` 忽略） |
| `MyWorkspace/Software/<name>/`（仓库外） | **运行体类**私有应用/服务：如带守护进程、日志、pid、开机自启的（与 `Software/lms-relay/` 同类）。约定：绿色（便携）软件运行目录 | — （本来就不在仓库内） |

> 💡 怎么选：只往仓库里搬 **能独立打包的 app 源码**；若这东西还要**长期常驻运行**（守护进程 / 日志 / 自启），
> 就把“运行体”放在仓库外的 `Software/<name>/`，插件源码可随手放在它的子目录（如 `Software/<name>/mpi-app/`），
> 避免被 `git clean -xdf` 连带删掉（见下文风险 2）。
> 实例：`Software/ecs443-tunnel/`（443 隧道提速：脚本 + 看门狗 + 自启 + `mpi-app/` 插件）。

根 `.gitignore` 的相关规则：

```gitignore
examples/apps/private/*
!examples/apps/private/README.md
```

## 使用

```bash
cd examples/apps/private/<id>
node pack.cjs                  # → dist/<id>-<版本>.zip
```

然后在 MPI → 应用商店 →「从 zip 安装」导入；也可「加载已解压目录」直接选该目录调试。

## ⚠️ 两条注意事项

1. **禁止 `git add -f`**：一旦强加入库，即使之后删除，内容仍留在历史里（推送后无法回收）。
   需要确认时用 `git check-ignore -v <文件>` 验证已被忽略。
2. **`git clean -xdf` 会连忽略的文件一起删**——包括本目录下的私有应用源码！
   建议给私有应用额外留一份备份（或把源码放到仓库之外，例如 `MyWorkspace/Work/` 下，只在需要时拷进来打包）。
