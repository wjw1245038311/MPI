---
lesson: memory-forget-ctx
module: unknown
tags: []
source: zhiya
guard-strength: directive
applies-when: []
---

# /memory-forget 命令执行前必须通过 ctx

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

/memory-forget 命令执行前必须通过 ctx.ui.confirm 二次确认，目标不存在时返回 invalid 而不静默成功。
