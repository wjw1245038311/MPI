---
lesson: memory-slash-command-usage
module: src/main/mpi-memory-ext
tags: [memory, slash-commands, usage, cli-surface]
source: zhiya
guard-strength: informational
applies-when: [using-memory-commands, documenting-memory-surface]
---

# /memory 斜杠命令的三种用法

> ⚠️ **这篇是"用法说明"，不是教训**。它更适合放在《记忆系统手册》里；
> 留在 KB 是因为自动化分诊只判"长期有效 + 本项目"，判不出"文档 vs 经验"。
> 若手册已覆盖，可归档本篇（`npm run memory:archive -- Lesson-HABGTFVA`）。

## Symptom

（非故障类，跳过）

## Root Cause

（非故障类，跳过）

## Fix

`/memory` 当前支持三种用法：

| 输入 | 行为 |
|---|---|
| `/memory <内容>` | 手动记一条（与 `/memory-remember` 同路径，原文直存） |
| `/memory` 或 `/memory list` | 浏览最近 20 条记忆池条目 |
| `/memory find <关键词>` | 按关键词**字面**检索（语义召回见 `procedure` 篇：扩展读不到 zvec 索引） |

## Guard

命令面变化时记得同步两处：本仓《记忆系统手册》（`resources/memory-manual.md`）与本篇；
扩展的注册表在 `src/main/mpi-memory-ext.ts` 的 `pi.registerCommand` 调用处。

## Evidence

- 记忆池条目 `01M2Z4VCCQ53JCPH71HABGTFVA`（提案 `01M2ZRQSV9NSHFPFY1D8XJHNFY` 批准落地）
- 原文：`/memory 斜杠命令当前支持三种用法：/memory <内容> 手动记录、/memory 或 /memory list 浏览最近20条记忆池、/memory find <关键词> 按关键词字面检索。`
