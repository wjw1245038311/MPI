---
lesson: memory-search-is-literal-in-extension
module: src/main/mpi-memory-ext
tags: [memory, extension, self-contained, recall, zvec, limitation]
source: zhiya
guard-strength: advisory
applies-when: [editing-extension-search, wiring-semantic-recall]
---

# 扩展里的 /memory 检索是字面的（读不到 zvec 索引）

## Symptom

在扩展里用 `/memory find <关键词>`（或 `/memory-search`）找一条**换种说法**的记忆时找不到 —— 内容明明在池子里，但关键词对不上就是查不出来。检索结果看起来只有"字面包含"的那几条，而主进程侧的检索（面板 / `memory-cli recall`）用同样的问题却能召回语义相近的条目。

## Root Cause

扩展文件（`mpi-memory-ext.ts`）是**自包含**的：它以源码形式写进 userData 后被 pi 加载，`import` 不到本仓模块，因此**读不到 zvec 索引**（索引由主进程持有与维护）。扩展侧只能读文件真相源（池子 Markdown）做字面匹配。

这是"扩展不能反向依赖主进程模块"这条架构约束的直接后果，不是 bug。

## Fix

分两条路：

- **要语义召回** → 走主进程侧：MPI 面板「记忆池」的检索框、`npm run memory:recall -- <问题>`、或扩展里向主进程端点 POST（`/recall` 已存在这条通道，见 `memory-endpoint.ts`）。
- **只要字面查找** → 扩展内 `/memory find` 够用，但要知道它的语义就是"包含匹配 + 时间排序"。

（P2 的 `memory_recall` 语义召回方案需要另行选择：走端点代理，或让扩展自带轻量向量检索。**尚未决定**。）

## Guard

在扩展里写检索相关代码前，先确认"这个能力是否需要索引"：**需要索引的一律走主进程**（端点 / IPC），不要在扩展里自己读 `.zvec/`——那是主进程的编译产物，且多进程读同一集合会抢锁。

## Evidence

- 记忆池条目 `01M2Z4VCXDKTTV3BNRYSSF13GQ`（提案 `01M2ZRQSV6X05RB19ZT054G8RD` 批准落地）
- 原文：`/memory 的检索目前是字面的，因为扩展受自包含限制无法读取 zvec 索引；P2 memory_recall 需要另行选择语义召回方案。`
- 相关代码：`src/main/memory-inbox.ts`（池读取）、`src/main/memory-endpoint.ts`（`/recall` 通道）、`src/main/mpi-memory-ext.ts`（扩展侧字面检索）
