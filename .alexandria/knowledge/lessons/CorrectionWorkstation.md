---
lesson: correction-workstation
module: unknown
tags: [correction, from-mem0, origin:平板, from-pi-hermes, user-said]
source: zhiya
guard-strength: directive
applies-when: []
---

# [correction] 同步 workstation 上传的配置时…

> ⚠️ 本节骨架由知芽自动生成：正文取自**记忆原文**（未设置记忆模型，未生成 lesson 正文）。
> `module` / `tags` / 各节内容需要人工整理；下面「原文」一节保留原始记录。

## Symptom

<!-- TODO：什么现象下会踩到？ -->

## Root Cause

<!-- TODO：为什么？ -->

## Fix

<!-- TODO：正确做法 -->

## Guard

<!-- TODO：以后怎么避免 -->

## Evidence

<!-- TODO：日志/命令/文件 -->

## 原文（待整理）

[correction] 同步 workstation 上传的配置时（用户说「根据workstation的新上传的配置，同步本地配置」），若 workstation 端做了大幅整理/重组（如 failures.md 从 61 行精简到 17 行、删除大量旧条目），用户明确要求直接采用 workstation 版本整体替换（原话：「全部用workstation的替代」「不合并」），而非按既有 union 约定保留双方条目。union 合并仅适用于两端各自新增条目的并行追加场景；当一端为明确权威源或已做清理重组时，以该端为准整体替换，丢弃本机未提交的记忆改动。 — Failed: Assistant 检测到三个记忆文件冲突后自动按既有 union 约定开始逐文件对比合并，用户两次纠正（「全部用workstation的替代」「不合并」）才改为直接 checkout workstation 版本。
