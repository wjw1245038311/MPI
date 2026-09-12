# 增量同步工作流（详细分步）

对应 SKILL.md 的工作流 A。目标是：**不遗漏用户可见变更，也不把内部改动塞进手册。**

## 0. 准备

- 确认当前目录是 MPI 仓库根（含 `changelog.md` 与 `resources/user-manual.md`）。
- 若上一次同步后已发布过版本，先确认 `resources/user-manual.md` 顶部「适用版本」是否还挂在上一个大版本——据此决定新水印。

## 1. 读水印

`read .pi/manual-sync.json`。结构示例：

```json
{
  "syncedThrough": {
    "version": "v0.6.9",
    "items": ["条目标题 A", "条目标题 B"]
  },
  "updatedAt": "2026-09-12",
  "notes": "手册已覆盖到 v0.6.9；Unreleased 尚未同步。"
}
```

- `version`：已完整同步到的版本分节。
- `items`：在 `Unreleased` 内已逐条同步过的条目**标题**（用标题而非编号，因为发版会重置编号）。
- 水印不存在时，先跑一次「初始化」：把 `version` 设为手册实际覆盖到的最后一个已发布版本，`items` 留空，`updatedAt` 填今天。

## 2. 算差分

```powershell
node scripts/manual-sync.mjs --report
```

脚本会：
- 解析 `changelog.md` 的每个 `## ` 分节；
- 找出「在 `syncedThrough.version` 之后」的所有版本分节，以及 `Unreleased` 中不在 `items` 里的条目；
- 对每条给出**建议章节**（依据 [section-map.md](section-map.md) 的主题关键词）。

`--json` 输出：

```json
{
  "syncedThrough": "v0.6.9",
  "pending": [
    { "section": "Unreleased", "title": "任务模式...", "suggestedChapter": "4. 任务模式", "userFacing": true }
  ],
  "skipped": []
}
```

> `userFacing` 由脚本按关键词做**初步**判定；最终以你的判断为准（规则见 section-map.md）。

## 3. 逐条判定用户可见性

对 `pending` 每条判为：

- **用户可见** → 进手册。特征：新增/改变用户能看到的界面、按钮、流程、默认值、快捷键、设置项、错误提示。
- **内部** → 跳过。特征：只影响 dev 构建、测试基建、文档自身、重构、纯内部 bugfix、性能优化且行为不变。

判定表见 [section-map.md](section-map.md)。跳过项要在汇报里列出，说明原因。

## 4. 出「手册更新计划」并等批准

格式：

```text
本轮待更新（用户可见）：
1. changelog「设置页重新分类」 → 第 17 节设置参考 + 第 7 节语音系统
   → 把 7 栏新结构写进 17.1~17.7，删除旧的「通用设置/数据存储」栏名。
2. changelog「工具信任列表易用化」 → 第 8 节权限模式
   → 补「一键信任常用扩展工具」小节。

跳过（内部）：
- 「测试注册表/应用内测试面板」：dev-only，不进用户手册。
- 「E2E 文档分立」：文档自身，不进手册。
```

**用户批准后再改。** 用户删减条目时按用户意见调整。

## 5. 中英文同步改写

对每个用户可见条目：

1. 定位目标章节（`section-map.md` 给的建议可被实际内容修正）。
2. 中文先改：新增小节或修订段落，遵循 [style-guide.md](style-guide.md)。
3. 英文同步：结构一一对应，表达本地化而非直译。
4. 目录与交叉链接：标题变化时更新文件顶部 TOC 与 `[第 N 节](#...)` 链接。
5. 顶部「适用版本」按需更新。

## 6. 回写水印

编辑 `.pi/manual-sync.json`：

- 若同步的是 `Unreleased` 条目 → 把标题加入 `items`。
- 若某个版本已**整节**同步完 → 可把 `version` 提升到该版本，并清空更早的 `items`。
- 更新 `updatedAt`。

## 7. 汇报

给用户：

- 改了哪些章节（中 + 英）。
- 跳过了哪些内部条目及原因。
- 水印新值。
- 未决问题（例如某功能行为不确定，建议实机确认）。

## 8. 质量自检

- [ ] 中英文都改了，且结构对应。
- [ ] 没有引入实现细节（IPC / 文件名 / 内部字段）。
- [ ] 目录与锚点仍可跳转。
- [ ] 没有把 dev-only 功能写成普通用户功能。
- [ ] 水印已更新。
