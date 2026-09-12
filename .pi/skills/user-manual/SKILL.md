---
name: user-manual
description: 维护 MPI 用户手册（resources/user-manual.md 与 resources/user-manual-en.md）。当用户说「更新用户手册 / 同步手册 / 写手册 / 手册太旧了 / 根据 changelog 更新手册」，或要把某个新功能补进手册、把某章改写得更通俗时使用。基于 changelog 做增量同步：先跑差分脚本列出待处理变更，按用户可见性筛选，再中英文同步改写。不适用于：写代码注释、写开发文档（docs/ 下的测试/设计文档）、或与 MPI 手册无关的其它文档。
---

# 用户手册维护 skill

维护 MPI 面向**普通用户**的手册。核心目标：**用户看得懂、和当前版本一致、中英文同步、只增量改该改的**。

## 手册在哪里

| 文件 | 说明 |
|---|---|
| `resources/user-manual.md` | 中文手册（22 章，主版本） |
| `resources/user-manual-en.md` | 英文手册（与中文对应） |
| `MPI-BEGINNER-GUIDE.md` | 新手指南，**风格标杆**（更通俗，改写时参考它的语气与结构） |
| `changelog.md` | 变更来源（`## Unreleased` 与各 `## vX.Y.Z` 分节） |
| `.pi/manual-sync.json` | 同步水印：记录手册已覆盖到哪个版本 / 哪些条目 |
| `scripts/manual-sync.mjs` | 差分脚本：列出自上次同步以来的待处理条目 |

手册由「帮助 → 用户手册」在应用内打开；`resources/*.md` 会随安装包发布。**只改源文件，不要动 `out/`。**

## 环境铁律

1. 命令在 **PowerShell 7** 下执行；JSON 操作用 node，不要用 `jq`/heredoc。
2. 改文件用 `read` / `edit` / `write`，不要用 shell 重定向。
3. 一次只改 `resources/user-manual*.md` 与 `.pi/manual-sync.json`（及本 skill 自己的文件）。不顺手改代码。
4. **中英文必须同步**：改了中文，同一轮把英文对应章节也改掉，否则英文用户看到旧内容。
5. 改完目录/锚点要自洽：章节标题变化时同步更新顶部 TOC 与文内链接。

## 两种工作流

### A. 增量同步（默认，用户说「同步手册 / 更新手册」时）

1. **读水印**：`read .pi/manual-sync.json`。不存在时，按 [section-map.md](references/section-map.md) 的说明初始化：以「手册当前实际覆盖到的最后一个已发布版本」为起点。
2. **算差分**：`node scripts/manual-sync.mjs --report` → 得到自水印以来 changelog 的新条目 + 建议章节。加 `--json` 可拿结构化结果。
3. **逐条判定**：对每条按 [section-map.md](references/section-map.md) 判为**用户可见**或**内部**。只有用户可见的才进手册；内部条目（dev-only、测试、重构、文档自身）直接跳过并说明。
4. **出计划，等批准**：给用户一份「手册更新计划」——每条：`changelog 条目 → 目标章节 → 拟做什么（一句话）`，以及「跳过的内部条目」。**用户批准前不要动手册。**
5. **改写**：按 [style-guide.md](references/style-guide.md) 中英文同步编辑（新增章节 / 修订段落 / 删除过时描述），同步目录与交叉链接。
6. **回写水印**：更新 `.pi/manual-sync.json`，把本轮已处理的条目记为已同步。
7. **汇报**：改了哪些章节、跳过了哪些、水印新值。

详细分步见 [workflow.md](references/workflow.md)。

### B. 单章通俗化改写（用户指定某章 / 说「这章看不懂」）

1. 读目标章节 + [style-guide.md](references/style-guide.md) + `MPI-BEGINNER-GUIDE.md` 找语感。
2. 先给「改写要点」让用户确认（保留哪些事实、砍掉哪些术语）。
3. 重写：**只改表达，不改功能事实**；步骤化、第二人称、术语先解释。
4. 中英同步；核对目录锚点。

## 通俗化的最低标准

- 先说「这是什么、什么时候用」，再说「怎么做」。
- 用「你」，用短句，一步一个动作，能编号就编号。
- 术语（线程 / 会话 / 权限 / 提供商 / MCP…）首次出现先用一句大白话解释。
- 表格只用于「选项 / 字段 / 默认值」对照，不用来解释概念。
- 每章尽量有「如果没生效怎么办」。
- 不写实现细节（IPC、文件名、内部字段名）——除非用户排查确实需要，且用「展开看」的方式弱化。

完整规则与正反例见 [style-guide.md](references/style-guide.md)。

## 快速命令

```powershell
# 列出待同步条目 + 章节建议
node scripts/manual-sync.mjs --report

# 结构化输出（便于脚本处理）
node scripts/manual-sync.mjs --json

# 校验差分脚本本身
npm test -- manual-sync
```
