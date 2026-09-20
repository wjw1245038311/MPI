---
lesson: memory-archive-default-location
module: AgentSetting/memory-archive
tags: [memory, archive, zhiya-pool, deletion-safety]
source: zhiya
guard-strength: directive
applies-when: ["处理记忆归档、清理或恢复", "未配置母版时定位归档目录"]
---

# 记忆系统归档默认位置与删除边界

## Symptom

记忆被“归档”后，在原始记忆中找不到；实际落在 `AgentSetting/archive/zhiya-pool/`。若未配置母版，则退回池内 `archived/`。此时容易误判为数据丢失或已删除。

原文：记忆系统归档默认落在 AgentSetting/archive/zhiya-pool/，未配置母版时退回池内 archived/，且归档不等同于删除。

## Root Cause

记忆系统的“归档”是状态迁移，不是物理删除。默认归档路径优先使用 `AgentSetting/archive/zhiya-pool/`；当母版未配置时，系统回退到当前池内的 `archived/` 目录。由于文件仍存在于磁盘上，只是从活跃记忆位置移动到归档位置，因此不能把“归档”理解为“删除”。

## Fix

1. 查找被归档记忆时，先检查默认路径：
   - `AgentSetting/archive/zhiya-pool/`
2. 如果未配置母版，再检查池内回退路径：
   - `<pool>/archived/`
3. 若需要恢复记忆，将文件从上述归档位置移回原活跃记忆目录，并保留原有元数据。
4. 只有在明确执行“删除”且确认不是归档操作时，才允许移除文件。

## Guard

- 任何涉及记忆清理的操作前，必须先检查目标路径是否命中 `AgentSetting/archive/zhiya-pool/**` 或池内 `archived/**`；命中则禁止直接删除。
- 未配置母版时，必须把归档目标解析为池内 `archived/`，不得写入其他临时目录。
- “删除记忆”只能作用于非归档状态且用户明确确认；归档操作必须保留可恢复路径和元数据。

## Evidence

- `AgentSetting/archive/zhiya-pool/`：默认归档目录
- `<pool>/archived/`：未配置母版时的回退归档目录
- 原文约束：“记忆系统归档默认落在 AgentSetting/archive/zhiya-pool/，未配置母版时退回池内 archived/，且归档不等同于删除。”
