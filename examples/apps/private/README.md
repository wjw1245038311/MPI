# 私有应用（不进版本库）

本目录用于放置**只给自己用**的 MPI 应用商店 app 包源码（例如与个人基础设施绑定的应用）。
它们**不进入版本库、不上传到任何远端**。

## 约定

| 位置 | 用途 | 是否入库 |
|---|---|---|
| `examples/apps/<id>/` | **公开示例**（如 `local-voice`），可被他人参考 | ✅ 入库 |
| `examples/apps/private/<id>/` | **私有应用**，含个人环境细节 | ❌ 不入库（本目录除本 README 外全部被 `.gitignore` 忽略） |

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
